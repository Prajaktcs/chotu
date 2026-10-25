import { Redirect } from "expo-router";

import { Progress } from "@/components/progress";
import { Screen } from "@/components/screen";
import { homeRoute, useConnection } from "@/connection";

/** Launch: setup, the profile picker or the workout, by what is saved. */
export default function Launch() {
  const connection = useConnection();
  if (connection.status === "loading") {
    return (
      <Screen style={{ justifyContent: "center" }}>
        <Progress label="Starting Chotu" />
      </Screen>
    );
  }
  return <Redirect href={homeRoute(connection)} />;
}
