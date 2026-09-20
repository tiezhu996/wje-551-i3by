import { v4 as uuid } from 'uuid';
import { ShipmentStatus, SupplierStatus } from '../constants/enums.js';
import { shipments, suppliers, warehouses } from '../database/seeds/initial.js';
import type { Shipment, User } from '../types/index.js';
import { auditService } from './audit.service.js';
import { inventoryService } from './inventory.service.js';
import { BusinessException } from '../utils/response.js';

function nextOrderNo() {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `SHIP-${date}-${String(shipments.length + 1).padStart(4, '0')}`;
}

export class ShipmentsService {
  list(query: Record<string, string | undefined>) {
    return shipments
      .filter((item) => !query.orderNo || item.orderNo.includes(query.orderNo))
      .filter((item) => !query.status || item.status === query.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  detail(id: string) {
    const shipment = shipments.find((item) => item.id === id);
    if (!shipment) throw new BusinessException(404, '运单不存在');
    return {
      ...shipment,
      supplier: suppliers.find((item) => item.id === shipment.supplierId),
      warehouse: warehouses.find((item) => item.id === shipment.warehouseId),
    };
  }

  create(payload: Pick<Shipment, 'supplierId' | 'warehouseId' | 'items' | 'estimatedArrival' | 'remark'>, user?: User) {
    const supplier = suppliers.find((item) => item.id === payload.supplierId);
    if (!supplier) throw new BusinessException(404, '供应商不存在');
    if (supplier.status === SupplierStatus.BLACKLISTED) throw new BusinessException(400, '黑名单供应商不能创建新的运单');
    const warehouse = warehouses.find((item) => item.id === payload.warehouseId);
    if (!warehouse) throw new BusinessException(404, '仓库不存在');
    const now = new Date().toISOString();
    const shipmentId = uuid();
    const shipment: Shipment = {
      id: shipmentId,
      orderNo: nextOrderNo(),
      supplierId: payload.supplierId,
      warehouseId: payload.warehouseId,
      status: ShipmentStatus.PENDING,
      trackingNo: '',
      carrier: '',
      estimatedArrival: payload.estimatedArrival,
      remark: payload.remark ?? '',
      items: payload.items.map((item) => ({ ...item, id: uuid(), shipmentId })),
      timeline: [{ id: uuid(), status: ShipmentStatus.PENDING, operator: user?.name ?? '系统', note: '创建运单', createdAt: now }],
      createdAt: now,
      updatedAt: now,
    };
    shipments.unshift(shipment);
    auditService.record({ action: 'CREATE', module: 'SHIPMENT', targetId: shipment.id, targetName: shipment.orderNo, detail: shipment }, user);
    return shipment;
  }

  ship(id: string, payload: { trackingNo: string; carrier: string }, user?: User) {
    const shipment = this.requireStatus(id, [ShipmentStatus.PENDING]);
    shipment.trackingNo = payload.trackingNo;
    shipment.carrier = payload.carrier;
    return this.transition(shipment, ShipmentStatus.SHIPPED, '发货', user);
  }

  transit(id: string, user?: User) {
    return this.transition(this.requireStatus(id, [ShipmentStatus.SHIPPED, ShipmentStatus.EXCEPTION]), ShipmentStatus.IN_TRANSIT, '在途更新', user);
  }

  private readonly receiveLocks = new Set<string>();

  receive(id: string, payload: { items?: Array<{ itemId?: string; receivedQuantity?: number | string | null }> }, user?: User) {
    const shipment = shipments.find((item) => item.id === id);
    if (!shipment) throw new BusinessException(404, '运单不存在');
    if (shipment.status === ShipmentStatus.DELIVERED) throw new BusinessException(400, '运单已签收，请勿重复提交');
    if (![ShipmentStatus.IN_TRANSIT, ShipmentStatus.EXCEPTION].includes(shipment.status)) {
      throw new BusinessException(400, `当前状态${shipment.status}不允许该操作`);
    }
    if (this.receiveLocks.has(id)) throw new BusinessException(409, '该运单签收正在处理中，请勿重复提交');
    this.receiveLocks.add(id);
    try {
      const submitted = new Map((payload.items ?? []).map((entry) => [String(entry.itemId), entry]));
      const diffs = shipment.items.map((item) => {
        const raw = submitted.get(item.id)?.receivedQuantity;
        const received = raw === undefined || raw === null || raw === '' ? null : Number(raw);
        if (received !== null && Number.isFinite(received)) item.receivedQuantity = received;
        const matched = received !== null && Number.isInteger(received) && received >= 0 && received === item.quantity;
        return { item, received, matched };
      });
      const mismatched = diffs.filter((diff) => !diff.matched);
      if (mismatched.length) {
        const note = `签收差异：${mismatched.map(({ item, received }) => {
          if (received === null) return `${item.skuId}未填写实收数量`;
          if (!Number.isFinite(received)) return `${item.skuId}实收数量无效`;
          return `${item.skuId}应到${item.quantity}实收${received}差异${received - item.quantity}`;
        }).join('；')}`;
        return this.transition(shipment, ShipmentStatus.EXCEPTION, note, user);
      }
      shipment.items.forEach((item) => inventoryService.inbound({ warehouseId: shipment.warehouseId, skuId: item.skuId, skuName: item.skuName, quantity: item.receivedQuantity ?? item.quantity }, user));
      shipment.actualArrival = new Date().toISOString();
      return this.transition(shipment, ShipmentStatus.DELIVERED, '签收并自动入库', user);
    } finally {
      this.receiveLocks.delete(id);
    }
  }

  exception(id: string, reason: string, user?: User) {
    const shipment = this.requireStatus(id, [ShipmentStatus.PENDING, ShipmentStatus.SHIPPED, ShipmentStatus.IN_TRANSIT]);
    shipment.remark = reason;
    return this.transition(shipment, ShipmentStatus.EXCEPTION, reason, user);
  }

  cancel(id: string, user?: User) {
    return this.transition(this.requireStatus(id, [ShipmentStatus.PENDING]), ShipmentStatus.CANCELLED, '取消运单', user);
  }

  private requireStatus(id: string, allowed: ShipmentStatus[]) {
    const shipment = shipments.find((item) => item.id === id);
    if (!shipment) throw new BusinessException(404, '运单不存在');
    if (!allowed.includes(shipment.status)) throw new BusinessException(400, `当前状态${shipment.status}不允许该操作`);
    return shipment;
  }

  private transition(shipment: Shipment, status: ShipmentStatus, note: string, user?: User) {
    const before = shipment.status;
    shipment.status = status;
    shipment.updatedAt = new Date().toISOString();
    shipment.timeline.unshift({ id: uuid(), status, operator: user?.name ?? '系统', note, createdAt: shipment.updatedAt });
    auditService.record({ action: 'STATUS_CHANGE', module: 'SHIPMENT', targetId: shipment.id, targetName: shipment.orderNo, detail: { before, after: status, note } }, user);
    return shipment;
  }
}

export const shipmentsService = new ShipmentsService();
