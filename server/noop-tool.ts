import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";

/** S0 placeholder so the plugin has one tool to load; replaced by docket_show in a later slice. */
export const noopTool = defineAgentTool({
  name: "docket_noop",
  title: "Docket no-op",
  description: "Does nothing. Placeholder while Docket is being built.",
  input: z.object({}),
  async execute() {
    console.log(`[docket] docket_noop called; PASEO_HOME=${process.env.PASEO_HOME ?? "<unset>"}`);
    return { text: `ok PASEO_HOME=${process.env.PASEO_HOME ?? "<unset>"}` };
  },
});
