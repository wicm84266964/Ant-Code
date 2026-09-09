import type { DashboardGatewayProfile } from "./app-core.ts";

export function modelPickerLabel(model: { id: string; label?: string; switchProfileId: string }, models: Array<{ id: string; label?: string; switchProfileId: string }>) {
  const remark = model.label && model.label !== model.id ? model.label : "";
  const label = remark ? `${model.id} (${remark})` : model.id;
  const duplicates = models.filter((other) => other.id === model.id && (other.label || other.id) === (model.label || model.id));
  if (duplicates.length < 2) return label;
  return `${label} (配置 ${duplicates.findIndex((other) => other.switchProfileId === model.switchProfileId) + 1})`;
}

export function modelConnectionGroups(profiles: DashboardGatewayProfile[]) {
  const groups = new Map<string, { id: string; label: string; profiles: DashboardGatewayProfile[] }>();
  for (const profile of profiles) {
    const id = String(profile.connectionGroupId || profile.id);
    let group = groups.get(id);
    if (!group) {
      group = { id, label: profile.gatewayUrl || profile.label || profile.id, profiles: [] };
      groups.set(id, group);
    }
    group.profiles.push(profile);
  }
  const result = [...groups.values()];
  const counts = new Map<string, number>();
  for (const group of result) counts.set(group.label, (counts.get(group.label) || 0) + 1);
  for (const group of result) {
    if ((counts.get(group.label) || 0) > 1) {
      const profile = group.profiles[0];
      group.label += ` (${profile.gatewayUrl || profile.id}; ${profile.id})`;
    }
  }
  return result;
}
