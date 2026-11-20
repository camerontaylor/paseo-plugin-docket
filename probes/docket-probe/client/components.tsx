import type {
  PluginAgentPanelProps,
  PluginHostProps,
  PluginScreenProps,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import React, { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type Copy, type Hub, snapshot } from "./hub";

/** Components are created per copy so each one can mark its own copy with the host it mounts under. */
export function makeComponents(copy: Copy, hub: Hub, report: (event: string, data: Record<string, unknown>) => void) {
  const noteHost = (where: string, props: PluginHostProps) => {
    const first = copy.hostId === null;
    copy.hostId = props.host.id;
    copy.hostLabel = props.host.label;
    copy.platform = props.layout.platform;
    report("mount", {
      where,
      first,
      compact: props.layout.compact,
      ...snapshot(hub),
      copyId: copy.copyId,
      hostId: copy.hostId,
      hostLabel: copy.hostLabel,
      platform: copy.platform,
    });
  };

  const useMount = (where: string, props: PluginHostProps) => {
    useEffect(() => {
      noteHost(where, props);
      return () => report("unmount", { where, copyId: copy.copyId, hostId: props.host.id });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.host.id]);
  };

  const useTick = () => {
    const [, set] = useState(0);
    useEffect(() => {
      const t = setInterval(() => set((n) => n + 1), 1000);
      return () => clearInterval(t);
    }, []);
  };

  function Status({ where }: { where: string }) {
    useTick();
    return (
      <View style={{ padding: 8 }}>
        <Text>{`probe ${where} · hub ${hub.hubId} (v${hub.hubVersion})`}</Text>
        {[...hub.copies.values()].map((c) => (
          <Text key={c.copyId}>
            {`copy ${c.copyId} host ${c.hostId ?? "?"} ${c.platform ?? "?"} bundle ${c.bundleVersion} counter ${c.lastCounter ?? "-"} (${c.counters} received)`}
          </Text>
        ))}
      </View>
    );
  }

  function Screen(props: PluginScreenProps) {
    useMount("screen", props);
    return <Status where="screen" />;
  }

  function SidebarItem(props: PluginSidebarItemProps) {
    useMount("sidebar-item", props);
    return (
      <Pressable onPress={() => props.openScreen({ screenId: "main" })} style={{ padding: 8 }}>
        <Text>{`Probe ${copy.lastCounter ?? "-"}`}</Text>
      </Pressable>
    );
  }

  function SidebarView(props: Pick<PluginHostProps, "theme" | "layout">) {
    useEffect(() => report("mount", { where: "sidebar-view", copyId: copy.copyId, platform: props.layout.platform }), []);
    return <Status where="sidebar-view" />;
  }

  function AgentPanel(props: PluginAgentPanelProps) {
    useMount("agent-panel", props);
    return <Status where="agent-panel" />;
  }

  function Renderer(props: PluginHostProps) {
    return <Text>{`docket-probe note on ${props.host.id}`}</Text>;
  }

  return { Screen, SidebarItem, SidebarView, AgentPanel, Renderer };
}
