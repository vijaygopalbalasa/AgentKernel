import {
  checkTestInfrastructure,
  startTestInfrastructure,
} from "../helpers/test-utils.js";

export default async function globalSetup() {
  const status = await checkTestInfrastructure();
  if (!status.postgres || !status.qdrant || !status.redis) {
    const result = await startTestInfrastructure();
    if (!result.ok) {
      throw new Error(`Failed to start infrastructure: ${result.error.message}`);
    }
  }
}
