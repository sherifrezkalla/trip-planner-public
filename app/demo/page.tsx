import type { Metadata } from "next";
import FictionalDemo from "./FictionalDemo";

export const metadata: Metadata = {
  title: "Try a fictional trip · Trip Planner",
  description: "Explore a fictional Lisbon day, preview a change and try a group decision. No account or setup needed.",
};

export default function DemoPage() {
  return <FictionalDemo />;
}
