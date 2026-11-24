import type { Profile } from "./types";

/** Shared Android Profile.allowKidsLiveTv field. Live TV has no age rating. */
export function canProfileOpenLiveTv(profile: Pick<Profile, "isKidsProfile" | "allowKidsLiveTv"> | null | undefined): boolean {
  return profile?.isKidsProfile !== true || profile.allowKidsLiveTv === true;
}
