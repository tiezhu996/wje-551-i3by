<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
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
const received = ref<Record<string, number | string | null>>({});
const submitting = ref(false);
const receiveError = ref('');

const canReceive = computed(() => !!store.current && [ShipmentStatus.IN_TRANSIT, ShipmentStatus.EXCEPTION].includes(store.current.status));

onMounted(async () => { await store.fetchDetail(id); resetReceived(); });

function resetReceived() {
  received.value = Object.fromEntries((store.current?.items ?? []).map((item) => [item.id, item.receivedQuantity ?? item.quantity]));
}

function shownReceived(row: any) { return canReceive.value ? received.value[row.id] : row.receivedQuantity; }
function diffOf(row: any) {
  const value = shownReceived(row);
  if (value === undefined || value === null || value === '') return null;
  return Number(value) - row.quantity;
}
function diffText(row: any) {
  const diff = diffOf(row);
  if (diff === null || Number.isNaN(diff)) return '-';
  return diff > 0 ? `+${diff}` : String(diff);
}

async function receive() {
  if (submitting.value) return;
  submitting.value = true;
  receiveError.value = '';
  try {
    await shipmentsApi.receive(id, { items: Object.entries(received.value).map(([itemId, receivedQuantity]) => ({ itemId, receivedQuantity })) });
    await store.fetchDetail(id);
    resetReceived();
  } catch (error: any) {
    receiveError.value = error?.response?.data?.message ?? '签收失败，请稍后重试';
  } finally {
    submitting.value = false;
  }
}
async function cancel() { await shipmentsApi.cancel(id); await store.fetchDetail(id); }
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
        <button v-if="canReceive" class="btn" :disabled="submitting" @click="receive">{{ submitting ? '签收提交中…' : '确认签收并入库' }}</button>
        <button v-if="store.current.status === ShipmentStatus.PENDING" class="btn secondary" @click="cancel">取消运单</button>
        <p v-if="store.current.status === ShipmentStatus.EXCEPTION" class="diff-hint">上次签收存在差异，运单已转入异常，请核对实收数量后重新提交。</p>
        <p v-if="receiveError" class="diff-hint">{{ receiveError }}</p>
      </div>
      <div class="panel">
        <h3>物流时间线</h3>
        <p v-for="event in store.current.timeline" :key="event.id"><StatusBadge :value="event.status" /> {{ event.note }} · {{ event.operator }} · {{ formatDate(event.createdAt) }}</p>
      </div>
    </div>
    <h3>运单明细（应到 / 实收 / 差异）</h3>
    <DataTable :columns="[{key:'skuId',title:'SKU'},{key:'skuName',title:'名称'},{key:'quantity',title:'应到数量'},{key:'receivedQuantity',title:'实收数量'},{key:'diff',title:'差异'}]" :data="store.current.items as any">
      <template #receivedQuantity="{ row }">
        <input v-if="canReceive" v-model.number="received[row.id]" class="qty-input" type="number" min="0" step="1" />
        <span v-else>{{ row.receivedQuantity ?? '-' }}</span>
      </template>
      <template #diff="{ row }">
        <span :class="{ 'diff-bad': diffOf(row) !== null && diffOf(row) !== 0 }">{{ diffText(row) }}</span>
      </template>
    </DataTable>
  </section>
</template>

<style scoped>
.qty-input { width:90px; padding:6px 8px; border:1px solid #c9d2c4; border-radius:6px; }
.diff-bad { color:#b3261e; font-weight:800; }
.diff-hint { color:#b3261e; font-size:13px; }
</style>
