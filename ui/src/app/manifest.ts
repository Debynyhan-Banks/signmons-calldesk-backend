import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Signmons CallDesk Field",
    short_name: "CallDesk Field",
    description:
      "Secure mobile job workflow for Signmons CallDesk technicians.",
    start_url: "/app/technician",
    display: "standalone",
    background_color: "#f3f6fa",
    theme_color: "#0b294c",
    orientation: "portrait-primary",
  };
}
