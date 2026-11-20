export const PURPOSES = {
  analytics: { label: '内部分析', short: '分析', desc: '统计与业务洞察' },
  personalization: { label: '个性化推荐', short: '推荐', desc: '基于行为做内容推荐' },
  marketing: { label: '营销触达', short: '营销', desc: '短信、Push 与人群圈选' },
  security: { label: '安全风控', short: '风控', desc: '反欺诈与异常识别' },
  service_quality: { label: '服务质检', short: '质检', desc: '客服工单与录音质检' },
  model_training: { label: '模型训练', short: '训练', desc: '用于模型训练与评测' },
  research: { label: '科研统计', short: '科研', desc: '聚合后的研究分析' },
};

export const SCOPES = {
  contact: {
    label: '联系方式',
    desc: '手机号、邮箱',
    fields: ['contact'],
    risk: 'high',
  },
  device_id: {
    label: '设备标识',
    desc: '设备号、IDFA',
    fields: ['device_id'],
    risk: 'medium',
  },
  location_precise: {
    label: '精确定位',
    desc: '经纬度坐标',
    fields: ['lat', 'lng'],
    risk: 'high',
  },
  location_coarse: {
    label: '城市级位置',
    desc: '城市 / 行政区',
    fields: ['city'],
    risk: 'medium',
  },
  behavior: {
    label: '行为事件',
    desc: '浏览、下单等事件',
    fields: ['behavior'],
    risk: 'medium',
  },
  voice: {
    label: '语音记录',
    desc: '客服通话录音',
    fields: ['voice'],
    risk: 'high',
  },
};

export const DATA_FIELDS = ['contact', 'device_id', 'lat', 'lng', 'city', 'behavior', 'voice'];

export const FIELD_SCOPE = {
  contact: 'contact',
  device_id: 'device_id',
  lat: 'location_precise',
  lng: 'location_precise',
  city: 'location_coarse',
  behavior: 'behavior',
  voice: 'voice',
};

export const JOB_TRIGGERS = {
  consent_narrowed: '授权收窄',
  consent_revoked: '授权撤回',
  consent_widened: '授权放宽',
  retention_policy: '保留期缩短',
  retention_sweep: '保留期到期清理',
  manual: '人工触发',
};

export const ACTOR = { id: 'linlan', name: '林澜', role: '数据合规负责人' };

export function purposeLabel(key) {
  return PURPOSES[key]?.label ?? key;
}

export function scopeLabel(key) {
  return SCOPES[key]?.label ?? key;
}

export function termsSummary(purposes, scopes, retentionDays, status = 'active') {
  if (status === 'revoked') return '授权已撤回';
  return `用途：${purposes.map(purposeLabel).join('、') || '无'} · 范围：${
    scopes.map(scopeLabel).join('、') || '无'
  } · 保留 ${retentionDays} 天`;
}
