import "dotenv/config";

import { ENV } from "../server/_core/env";
import { chatCompletion, listVeniceModels } from "../server/_core/venice";

const main = async () => {
  console.log(`Base URL: ${ENV.veniceApiBaseUrl}`);
  console.log(`Model:    ${ENV.veniceModel}`);
  console.log(
    `API key:  ${ENV.veniceApiKey ? `set (${ENV.veniceApiKey.length} chars)` : "MISSING"}`
  );

  if (!ENV.veniceApiKey) {
    throw new Error("VENICE_API_KEY is not set in the environment");
  }

  const { data: models } = await listVeniceModels();
  console.log(`\n/models -> ${models.length} models available`);

  const result = await chatCompletion({
    messages: [
      { role: "system", content: "You are a terse assistant." },
      {
        role: "user",
        content: "Reply with exactly: Venice is connected. No other words.",
      },
    ],
    maxTokens: 32,
    temperature: 0,
  });

  console.log("\n/chat/completions ->");
  console.log(`  id:           ${result.id}`);
  console.log(`  model:        ${result.model}`);
  console.log(`  finish:       ${result.finishReason}`);
  console.log(`  content:      ${JSON.stringify(result.content)}`);
  console.log(
    `  usage:        ${JSON.stringify(result.usage ?? null, null, 2).replace(/\n/g, "\n               ")}`
  );

  if (!result.content.trim()) {
    throw new Error("Expected non-empty content from the model");
  }

  console.log("\nOK");
};

main().catch(error => {
  console.error(
    `\nFAILED: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
