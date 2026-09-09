type RecordValue = Record<string, any>;

// URLs are compared exactly, including port and API path. Never group by host.
export function sourceCredentialState(config: RecordValue) {
  const lab = config.lab ?? {};
  const profiles: RecordValue[] = Array.isArray(lab.gatewayProfiles) ? lab.gatewayProfiles : [];
  const groups = new Map<string, RecordValue[]>();
  for (const profile of profiles) {
    const url = String(profile.gatewayUrl || "");
    if (!url) continue;
    groups.set(url, [...(groups.get(url) ?? []), profile]);
  }
  const result: Record<string, string | null> = {};
  for (const [url, members] of groups) {
    const explicit = lab.sourceCredentialSelections?.[url];
    const retained = lab.resolvedSourceCredentials?.[url];
    const requested = explicit ?? retained;
    if (requested !== undefined) {
      result[url] = members.find((p) => p.id === requested)?.id ?? null;
      continue;
    }
    const keys = new Set(members.map((p) => JSON.stringify([p.gatewayApiKeyDisabled === true, p.gatewayApiKey || ""])));
    const active = members.find((p) => p.id === lab.activeGatewayProfile);
    result[url] = keys.size === 1 ? members[0].id : active?.id ?? null;
  }
  return result;
}

export function applySourceCredentials<T extends RecordValue>(config: T): T {
  const lab = config.lab ?? {};
  const resolved = sourceCredentialState(config);
  const url = String(lab.gatewayUrl || "");
  if (!(url in resolved)) return config;
  const selected = (lab.gatewayProfiles ?? []).find((p: RecordValue) => p.id === resolved[url] && p.gatewayUrl === url);
  return { ...config, lab: {
    ...lab, resolvedSourceCredentials: resolved,
    sourceCredentialSelectionRequired: !selected,
    gatewayApiKey: selected?.gatewayApiKeyDisabled === true ? null : selected?.gatewayApiKey ?? null,
    gatewayApiKeyDisabled: !selected || selected.gatewayApiKeyDisabled === true
  } };
}
