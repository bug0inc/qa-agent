import type { EmailProvider } from "../config";
import { EMAIL_FETCH_TIMEOUT } from "../constants";

/**
 *  Emailsink is a simple email service by Bug0 that allows you to receive emails at a unique address and retrieve their content via an API
 *  The free plan doesn't require an API key, but you can consider getting one by upgrading to a paid plan for higher rate limits and reliability.
 *
 * @param options - Configuration options for the Emailsink provider
 * @returns An EmailProvider instance
 */
export function emailsinkProvider(options: { apiKey?: string }): EmailProvider {
  return {
    domain: "emailsink.dev",
    extractContent: async ({ email, prompt }) => {
      let url = `https://get.emailsink.dev/?email=${encodeURIComponent(email)}&prompt=${encodeURIComponent(prompt)}`;
      if (options.apiKey) {
        url += `&secret=${encodeURIComponent(options.apiKey)}`;
      }
      const response = await fetch(url, {
        signal: AbortSignal.timeout(EMAIL_FETCH_TIMEOUT),
      });
      const data = (await response.json()) as { result: string | undefined };

      let result = data.result;

      // Handle case where result is a string containing a JSON object
      if (typeof result === "string" && result.startsWith("{")) {
        try {
          const parsedResult = JSON.parse(result);
          result = parsedResult.result;
        } catch {
          // Keep the original result if parsing fails
        }
      }

      if (result !== undefined && result !== null && result !== "") {
        return result;
      }

      throw new Error("No email content found");
    },
  };
}
