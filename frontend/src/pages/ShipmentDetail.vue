<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { shipmentsApi } from '../api/shipments';
import DataTable from '../components/common/DataTable.vue';
import StatusBadge from '../components/common/StatusBadge.vue';
import { ShipmentStatus } from '../constants/enums';
import { useShipmentStore } from '../stores/shipmentStore';
import { formatDate } from '../utils/format';

const route = useRoute();
const store = useShipmentStore();
const id = String(route.params.id);
const receiving = ref(false);
const submitting = ref(false);
const receiptQuantities = reactive<Record<string, number | undefined>>({});

onMounted(() => store.fetchDetail(id));

const canReceive = computed(() => store.current?.status === ShipmentStatus.IN_TRANSIT || store.current?.status === ShipmentStatus.EXCEPTION);

function openReceive() {
  store.current?.items.forEach((item) => { receiptQuantities[item.id] = item.receivedQuantity ?? item.quantity; });
  receiving.value = true;
}

async function submitReceive() {
  if (submitting.value || !store.current) return;
  submitting.value = true;
  try {
    const items = store.current.items.map((item) => ({ itemId: item.id, receivedQuantity: Number(receiptQuantities[item.id]) }));
    await shipmentsApi.receive(id, { items });
    receiving.value = false;
    await store.fetchDetail(id);
  } finally {
    submitting.value = false;
  }
}

async function cancel() { await shipmentsApi.cancel(id); await store.fetchDetail(id); }

function diffOf(item: { quantity: number; receivedQuantity?: number }) {
  return item.receivedQuantity === undefined ? null : item.receivedQuantity - item.quantity;
}
</script>

<template>
  <section v-if="store.current">
    <div class="page-title"><h2>{{ store.current.orderNo }}</h2><StatusBadge :value="store.current.status" /></div>
    <div class="grid two">
      <div class="panel">
        <h3>运单信息</h3>
        <p>承运方：{{ store.current.carrier || '-' }}</p>
        <p>追踪号：{{ store.current.trackingNo || '-' }}</p>
        <p>预计到达：{{ formatDate(store.current.estimatedArrival) }}</p>
        <p>实际到达：{{ formatDate(store.current.actualArrival) }}</p>
        <p>备注：{{ store.current.remark || '-' }}</p>
        <button v-if="canReceive" class="btn" @click="openReceive">{{ store.current.status === ShipmentStatus.EXCEPTION ? '重试签收' : '签收并入库' }}</button>
        <button v-if="store.current.status === ShipmentStatus.PENDING" class="btn secondary" @click="cancel">取消运单</button>
      </div>
      <div class="panel">
        <h3>物流时间线</h3>
        <p v-for="event in store.current.timeline" :key="event.id"><StatusBadge :value="event.status" /> {{ event.note }} · {{ event.operator }} · {{ formatDate(event.createdAt) }}</p>
      </div>
    </div>
    <div v-if="receiving" class="panel">
      <h3>签收确认（按明细填写实收数量）</h3>
      <p class="tip">全部明细实收与应到一致才会入库并签收；任一缺少、负数或数量不符将整单标记异常且不改库存。</p>
      <div v-for="item in store.current.items" :key="item.id" class="receive-row">
        <span class="receive-label">{{ item.skuId }} · {{ item.skuName }}（应到 {{ item.quantity }}）</span>
        <input v-model.number="receiptQuantities[item.id]" type="number" min="0" step="1" placeholder="实收数量" />
      </div>
      <button class="btn" :disabled="submitting" @click="submitReceive">{{ submitting ? '提交中...' : '确认签收' }}</button>
      <button class="btn secondary" :disabled="submitting" @click="receiving = false">取消</button>
    </div>
    <h3>运单明细</h3>
    <DataTable
      :columns="[{key:'skuId',title:'SKU'},{key:'skuName',title:'名称'},{key:'quantity',title:'应到数量'},{key:'receivedQuantity',title:'实收数量'},{key:'difference',title:'差异'}]"
      :data="store.current.items as any"
    >
      <template #receivedQuantity="{ row }">{{ row.receivedQuantity ?? '—' }}</template>
      <template #difference="{ row }">
        <span v-if="diffOf(row) === null">—</span>
        <span v-else :class="diffOf(row) === 0 ? 'diff-ok' : 'diff-bad'">{{ diffOf(row)! > 0 ? '+' : '' }}{{ diffOf(row) }}</span>
      </template>
    </DataTable>
  </section>
</template>

<style scoped>
.tip { color: #8a6d1d; font-size: 13px; }
.receive-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.receive-label { flex: 1; }
.receive-row input { width: 140px; padding: 6px 8px; border: 1px solid #c9d2c4; border-radius: 6px; }
.diff-ok { color: #2f7d32; font-weight: 700; }
.diff-bad { color: #c0392b; font-weight: 700; }
</style>
