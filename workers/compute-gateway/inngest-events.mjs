import { INNGEST_EVENT_KEY } from "./config.mjs";

export async function publishInngestEvent(name, data) {
  if (!INNGEST_EVENT_KEY) {
    return;
  }

  try {
    const response = await fetch(`https://inn.gs/e/${INNGEST_EVENT_KEY}`, {
      body: JSON.stringify({ data, name }),
      headers: {
        "content-type": "application/json"
      },
      method: "POST"
    });

    if (!response.ok) {
      console.warn(`Inngest event ${name} rejected with ${response.status}.`);
    }
  } catch (error) {
    console.warn(
      `Inngest event ${name} could not be published: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  }
}
