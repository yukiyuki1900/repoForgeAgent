<template>
  <div class="order">
    <OrderCard :id="id" />
    <price-tag :value="total" />
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import OrderCard from "@/components/OrderCard.vue";
import PriceTag from "@/components/PriceTag.vue";
import { formatPrice } from "@/utils/price";

const id = ref("1");
const total = formatPrice(100);
</script>
