import { redirect } from "next/navigation";

/** PEAD tab removed — send bookmarks to Napkin. */
export default function PeadPage() {
  redirect("/");
}
