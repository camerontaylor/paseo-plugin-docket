import type { PluginClientContext } from "@getpaseo/plugin/client";
import { startSource } from "./client/source";

export default function contribute(client: PluginClientContext) {
  return startSource(client);
}
