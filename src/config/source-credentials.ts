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
    result[url] = pickSourceCredential(members, lab, explicit ?? retained);
  }
  return result;
}

function pickSourceCredential(members: RecordValue[], lab: RecordValue, requested: unknown) {
  const requestedId = typeof requested === "string" ? requested.trim() : "";
  if (requestedId) {
    const saved = members.find((profile) => profile.id === requestedId);
    if (saved) {
      return saved.id;
    }
  }
  const keys = new Set(members.map((profile) => JSON.stringify([profile.gatewayApiKeyDisabled === true, profile.gatewayApiKey || ""])));
  if (keys.size === 1) {
    return members[0].id;
  }
  const active = members.find((profile) => profile.id === lab.activeGatewayProfile);
  if (active) {
    return active.id;
  }
  return members[0]?.id ?? null;
}

export function sourceHasAlternateCredentials(config: RecordValue) {
  return distinctSourceCredentialCount(config) > 1;
}

export function sourceCredentialFailureMessage(canSwitch: boolean, status: number | null = null) {
  const action = canSwitch
    ? "请打开设置，为这个来源切换生效凭据后再试。"
    : "请到设置页检查这份凭据。";
  const http = Number.isInteger(status) && Number(status) > 0 ? `（HTTP ${status}）` : "";
  return `当前生效凭据不能用。${action}${http}`;
}

function distinctSourceCredentialCount(config: RecordValue) {
  const lab = config.lab ?? {};
  const url = String(lab.gatewayUrl || "");
  if (!url) {
    return 0;
  }
  const profiles: RecordValue[] = Array.isArray(lab.gatewayProfiles) ? lab.gatewayProfiles : [];
  const keys = new Set(
    profiles
      .filter((profile) => String(profile.gatewayUrl || "") === url)
      .map((profile) => JSON.stringify([profile.gatewayApiKeyDisabled === true, profile.gatewayApiKey || ""]))
  );
  return keys.size;
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
