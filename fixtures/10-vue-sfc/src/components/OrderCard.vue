<template>
  <section class="card">{{ label }}</section>
</template>

<script setup lang="ts">
import { formatPrice } from "@/utils/price";

const label = formatPrice(0);
</script>
