import { config } from "../config.js";
import { processBatch } from "../services/send-service.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


console.log("Send worker started...");
while (true) {
  const result = await processBatch();
  if (result.processed > 0) {
    console.log(`Batch processed=${result.processed} sent=${result.sent} failed=${result.failed} suppressed=${result.suppressed}`);
  } else if (result.reason === "quota_reached") {
    console.log("Daily quota reached. Waiting...");
  }
  await sleep(config.loopIntervalSeconds * 1000);
}
