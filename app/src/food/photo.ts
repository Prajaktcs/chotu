import * as ImagePicker from "expo-image-picker";

import type { MealPhoto } from "@/api";

/** A photo attached to a meal being added: shown as a preview, sent as `photo`. */
export type PickedPhoto = { uri: string; photo: MealPhoto };

export type PhotoSource = "camera" | "library";

/** JPEG compression keeps a phone photo well under the server's 8 MB limit. */
const OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ["images"],
  quality: 0.5,
  base64: true,
  exif: false,
};

/** Takes or picks one photo; `null` when cancelled, `"denied"` without camera access. */
export async function pickMealPhoto(source: PhotoSource): Promise<PickedPhoto | "denied" | null> {
  if (source === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return "denied";
  }
  const result =
    source === "camera"
      ? await ImagePicker.launchCameraAsync(OPTIONS)
      : await ImagePicker.launchImageLibraryAsync(OPTIONS);
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset?.base64) return null;
  return {
    uri: asset.uri,
    photo: { content_type: asset.mimeType ?? "image/jpeg", data: asset.base64 },
  };
}
