<template>
  <view class="brand-row">
    <image class="logo" :class="size" src="/static/mascot/brand.png" mode="aspectFit" aria-hidden="true" />
    <text v-if="showName" class="brand-name">{{ appName }}</text>
  </view>
</template>

<script setup>
// 品牌标识：黄色圆角方块里的坑坑（土拨鼠）。2026-11-11 老板选定，替换原来的「暂停键」方块。
import { APP_NAME } from '@/common/brand.js';

defineOptions({ name: 'BrandMark' });

defineProps({
  showName: { type: Boolean, default: true },
  size: { type: String, default: 'md' }, // sm / md / lg
});
const appName = APP_NAME;
</script>

<style lang="scss" scoped>
.brand-row {
  display: flex;
  flex-direction: row;
  align-items: center;
}

// 32px 设计稿 → 61rpx
.logo {
  width: 61rpx;
  height: 61rpx;
  margin-right: 19rpx;
  flex-shrink: 0;

  &.sm {
    width: 54rpx;
    height: 54rpx;
    margin-right: 15rpx;
  }

  &.lg {
    width: 96rpx;
    height: 96rpx;
    margin-right: 0;
  }
}

.brand-name {
  font-size: 33rpx;
  font-weight: 900;
  color: $ink;
  letter-spacing: 1rpx;
}
</style>
