import assert from "node:assert/strict";
import test from "node:test";
import { publicGatewayProfiles } from "../../src/dashboard/runtime/public-config.ts";
import { modelConnectionGroups, modelPickerLabel } from "../../src/dashboard/public/model-groups.ts";
import { normalizeModelConfigInput } from "../../src/dashboard/runtime/settings.ts";

test("model remarks distinguish routes without showing internal IDs", () => {
  const models = [
    { id: "deepseek", label: "科研分析", switchProfileId: "provider-private-a" },
    { id: "deepseek", label: "代码开发", switchProfileId: "provider-private-b" }
  ];
  assert.equal(modelPickerLabel(models[0], models), "deepseek (科研分析)");
  models[1].label = "科研分析";
  assert.equal(modelPickerLabel(models[1], models), "deepseek (科研分析) (配置 2)");
  models.forEach((model) => { model.label = model.id; });
  assert.equal(modelPickerLabel(models[0], models), "deepseek (配置 1)");
});

test("same-source duplicate models require a remark but edits exclude their own profile", () => {
  const gatewayUrl = "http://127.0.0.1:9000/v1/chat/completions";
  const config = { lab: { gatewayProfiles: [{
    id: "existing", gatewayUrl, gatewayProtocol: "openai-chat", modelAlias: "deepseek",
    models: [{ id: "deepseek", label: "deepseek" }]
  }] } };
  const input = { gatewayUrl, modelId: "deepseek", gatewayProtocol: "openai-chat", profileId: "new-profile" };
  assert.equal(normalizeModelConfigInput(input, config).ok, false);
  assert.equal(normalizeModelConfigInput({ ...input, label: "deepseek" }, config).ok, false);
  const named = normalizeModelConfigInput({ ...input, label: "科研分析" }, config);
  assert.equal(named.ok, true);
  if (named.ok) assert.equal(named.model.label, "科研分析");
  assert.equal(normalizeModelConfigInput({ ...input, profileId: "existing" }, config).ok, true);
  assert.equal(normalizeModelConfigInput({ ...input, profileId: "" }, config).ok, true);
  assert.equal(normalizeModelConfigInput({ ...input, profileId: "" }, { ...config, configV2: { enabled: true } }).ok, false);
  assert.equal(normalizeModelConfigInput({ ...input, gatewayUrl: "http://127.0.0.1:9001/v1/chat/completions" }, config).ok, true);
});

test("model picker groups URLs regardless of key or protocol without exposing credentials", () => {
  const profile = (id: string, key: string, protocol = "openai-chat") => ({
    id, label: "127.0.0.1", gatewayUrl: "http://127.0.0.1:9000/v1", gatewayProtocol: protocol,
    gatewayApiKey: key, modelAlias: id, models: { [id]: { upstreamModel: id } }
  });
  const profiles = publicGatewayProfiles({ lab: { gatewayProfiles: [
    profile("a", "fake-key-one"), profile("b", "fake-key-one"),
    profile("c", "fake-key-two"), profile("d", "fake-key-one", "openai-responses")
  ] } } as any);
  assert.equal(profiles[0].connectionGroupId, profiles[1].connectionGroupId);
  assert.equal(profiles[0].connectionGroupId, profiles[2].connectionGroupId);
  assert.equal(profiles[0].connectionGroupId, profiles[3].connectionGroupId);
  assert.doesNotMatch(JSON.stringify(profiles), /fake-key/);
  const groups = modelConnectionGroups(profiles);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "http://127.0.0.1:9000/v1");
  assert.deepEqual(groups[0].profiles.map((item) => item.id), ["a", "b", "c", "d"]);
});

test("older servers do not group profiles solely by a matching public URL", () => {
  assert.equal(modelConnectionGroups([
    { id: "a", label: "local", gatewayUrl: "http://127.0.0.1" },
    { id: "b", label: "local", gatewayUrl: "http://127.0.0.1" }
  ]).length, 2);
});
