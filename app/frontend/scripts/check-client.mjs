// Exercise the real API client, without a browser or invented analytical results.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8")
  .replace(/import\.meta\.glob\([^;]+\);/, "({});");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const mod = { exports: {} }, requests = [];
let failure = false;
const context = vm.createContext({
  module: mod, exports: mod.exports,
  require: (name) => name === "./config" ? { USE_MOCKS: false } : require(name),
  URLSearchParams, setTimeout, structuredClone,
  fetch: async (path, init) => {
    requests.push({ path, init });
    return failure
      ? { ok: false, status: 422, statusText: "Unprocessable Entity", json: async () => ({ detail: "Policy rejected" }) }
      : { ok: true, json: async () => ({ from_api: true }) };
  },
});
vm.runInContext(compiled, context);
const { api, ApiError } = mod.exports;
for (const policy of ["controlled", "controlled_best_price"]) {
  const match = "E0_fixture/encoded", model = "marketnet";
  await api.replay(match, model, { prob_stress_delta: 0, min_ev: 0.02 }, policy);
  await api.reveal(match, model, policy);
  await api.explain(match, model, { price_haircut: 0.01 }, policy);
  for (const request of requests.slice(-3)) {
    const url = new URL(request.path, "http://app.test");
    assert.equal(url.searchParams.get("policy_id"), policy);
    assert.equal(url.searchParams.get("model_id"), model);
    assert.ok(url.pathname.includes("E0_fixture%2Fencoded"));
  }
  assert.equal(new URL(requests.at(-3).path, "http://app.test").searchParams.get("prob_stress_delta"), "0");
  assert.equal(requests.at(-1).init.method, "POST");
}
await api.replay("fixture");
assert.equal(new URL(requests.at(-1).path, "http://app.test").searchParams.get("policy_id"), "controlled");
await api.evidence("lgbm", "validation");
assert.equal(new URL(requests.at(-1).path, "http://app.test").searchParams.get("split"), "validation");
failure = true;
await assert.rejects(api.reveal("fixture"), (error) => error instanceof ApiError && error.status === 422 && error.message === "Policy rejected");
console.log("API client checks passed: both price policies reach replay, reveal and explanation; zero overrides survive; errors remain explicit.");
