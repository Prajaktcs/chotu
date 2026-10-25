import { screen } from "@testing-library/react-native";
import { renderRouter } from "expo-router/testing-library";

describe("app", () => {
  it("renders the home screen through the root layout", async () => {
    await renderRouter("./src/app");

    expect(await screen.findByRole("header", { name: "Chotu" })).toBeTruthy();
  });
});
