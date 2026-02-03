import {
  checkTestInfrastructure,
  startTestInfrastructure,
} from "../helpers/test-utils.js";

export default async function globalSetup() {
  process.env.REQUIRE_MANIFEST_SIGNATURE = "false";
  process.env.MANIFEST_SIGNING_SECRET = "";
  process.env.ENFORCE_EGRESS_PROXY = "false";
  process.env.DISTRIBUTED_SCHEDULER = "false";
  const status = await checkTestInfrastructure();
  if (!status.postgres || !status.qdrant || !status.redis) {
    const result = await startTestInfrastructure();
    if (!result.ok) {
      throw new Error(`Failed to start infrastructure: ${result.error.message}`);
    }
  }
}
