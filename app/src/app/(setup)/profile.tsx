import { Redirect } from "expo-router";

import { useConnection } from "@/connection";
import { ProfilePickerScreen } from "@/connection/screens/profile-picker-screen";

export default function ProfileRoute() {
  const { status, serverUrl } = useConnection();
  if (status === "ready" && !serverUrl) return <Redirect href="/setup" />;
  return <ProfilePickerScreen />;
}
