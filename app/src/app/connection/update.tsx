import { useLocalSearchParams } from "expo-router";

import { UpdateScreen } from "@/connection/screens/recovery-screens";

export default function UpdateRoute() {
  const { required } = useLocalSearchParams<{ required?: string }>();
  return <UpdateScreen requiredVersion={required ?? null} />;
}
