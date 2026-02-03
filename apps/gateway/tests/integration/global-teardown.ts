import { stopTestInfrastructure } from "../helpers/test-utils.js";

export default async function globalTeardown() {
  await stopTestInfrastructure();
}
