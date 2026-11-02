import { useRouter } from "expo-router";
import { useCallback } from "react";
import { Pressable, View } from "react-native";

import { useProfileSession } from "@/connection";
import {
  entryScreen,
  type ScreenId,
  type Section,
  screenHrefs,
  sectionOf,
  sections,
} from "@/navigation/sections";
import { useTheme } from "@/theme";

import { ThemedText } from "./themed-text";

/**
 * Moves between sections and tabs. Today is the root: leaving it pushes, so
 * Back returns to it; moving between other screens replaces, so Back never
 * walks through every tab visited; going to Today returns to it.
 */
export function useSectionNavigation(current: ScreenId) {
  const router = useRouter();
  return useCallback(
    (target: ScreenId) => {
      if (target === current) return;
      const href = screenHrefs[target];
      if (target === "today") router.dismissTo(href);
      else if (current === "today") router.push(href);
      else router.replace(href);
    },
    [current, router],
  );
}

/** The four tabs of the current screen's section. Tabs not built yet are disabled. */
export function SectionTabs({ screen }: { screen: ScreenId }) {
  const theme = useTheme();
  const go = useSectionNavigation(screen);
  const section = sectionOf(screen);
  if (section.tabs.length === 0) return null;
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={`${section.label} tabs`}
      style={{
        flexDirection: "row",
        gap: theme.spacing.xs,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.outline,
        paddingBottom: theme.spacing.sm,
      }}
    >
      {section.tabs.map((tab) => {
        const active = tab.screen === screen;
        const available = tab.screen !== undefined;
        return (
          <Pressable
            key={tab.label}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityHint={available ? undefined : "Not available yet"}
            accessibilityState={{ selected: active, disabled: !available }}
            aria-selected={active}
            aria-disabled={!available}
            disabled={!available}
            onPress={() => {
              if (tab.screen) go(tab.screen);
            }}
            style={{
              flex: 1,
              minHeight: theme.minTapTarget,
              minWidth: theme.minTapTarget,
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: theme.spacing.xs,
              borderRadius: theme.radii.full,
              backgroundColor: active ? theme.colors.container : "transparent",
            }}
          >
            <ThemedText
              variant="label"
              medium={available}
              color={active ? "text" : "muted"}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.85}
            >
              {tab.label}
            </ThemedText>
            {available ? null : (
              <ThemedText variant="label" color="muted" style={{ fontSize: 12 }}>
                Soon
              </ThemedText>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

export type SectionListProps = {
  screen: ScreenId;
  /** Called after a destination is chosen (the drawer closes). */
  onNavigate?: () => void;
};

/** The section list in the drawer and the expanded sidebar. */
export function SectionList({ screen, onNavigate }: SectionListProps) {
  const theme = useTheme();
  const router = useRouter();
  const { profile } = useProfileSession();
  const go = useSectionNavigation(screen);
  const current = sectionOf(screen).id;

  const row = (section: Section) => {
    const target = section.group === "main" ? entryScreen(section) : null;
    return (
      <SectionRow
        key={section.id}
        label={section.label}
        note={target ? undefined : section.group === "future" ? "Coming later" : "Coming soon"}
        selected={section.id === current}
        onPress={
          target
            ? () => {
                onNavigate?.();
                go(target);
              }
            : undefined
        }
      />
    );
  };

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <ThemedText color="muted">{profile.name}</ThemedText>
      <ThemedText variant="overline" color="muted" style={{ marginTop: theme.spacing.sm }}>
        Your sections
      </ThemedText>
      {sections.filter((section) => section.group === "main").map(row)}
      <ThemedText variant="overline" color="muted" style={{ marginTop: theme.spacing.sm }}>
        Coming later
      </ThemedText>
      {sections.filter((section) => section.group === "future").map(row)}
      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: theme.colors.outline,
          marginTop: theme.spacing.sm,
          paddingTop: theme.spacing.sm,
        }}
      >
        <SectionRow
          label="Settings"
          selected={false}
          onPress={() => {
            onNavigate?.();
            router.push("/settings");
          }}
        />
      </View>
    </View>
  );
}

function SectionRow({
  label,
  note,
  selected,
  onPress,
}: {
  label: string;
  /** Why the row is unavailable. */
  note?: string;
  selected: boolean;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const disabled = onPress === undefined;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={note ? `${label}, ${note.toLowerCase()}` : label}
      accessibilityState={{ selected, disabled }}
      aria-selected={selected}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 56,
        justifyContent: "center",
        paddingHorizontal: theme.spacing.lg,
        borderRadius: theme.radii.full,
        backgroundColor: selected ? theme.colors.container : "transparent",
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <ThemedText medium={!disabled} color={disabled ? "muted" : "text"}>
        {label}
      </ThemedText>
      {note ? (
        <ThemedText variant="label" color="muted">
          {note}
        </ThemedText>
      ) : null}
    </Pressable>
  );
}
