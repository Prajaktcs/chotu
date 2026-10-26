import { useLocalSearchParams } from "expo-router";

import { TokenScreen } from "@/connection/screens/recovery-screens";

export default function TokenRoute() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  return <TokenScreen replace={mode === "replace"} />;
}
