import { createRoot } from "react-dom/client";
import { EditorApp } from "./editor/EditorApp";
import "./styles.css";

const el = document.getElementById("root");
if (el) createRoot(el).render(<EditorApp />);
