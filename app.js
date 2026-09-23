import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { db } from "./firebase-config.js";

const BOOKINGS_COLLECTION = "bookings";

function deriveState(booking, now) {
  const start = new Date(booking.start);
  const due = new Date(booking.due);
  if (now >= start && now <= due) return "live";
  if (now > due) return "past";
  return "upcoming";
}

function formatDateTime(date) {
  const dayPart = date.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "short" });
  const timePart = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(" ", "");
  return `${dayPart}, ${timePart}`;
}

async function renderDetail() {
  const params = new URLSearchParams(window.location.search);
  const eventId = params.get("id");
  const content = document.getElementById("detail-content");
  if (!eventId || !content) return;

  let event;
  try {
    const snap = await getDoc(doc(db, BOOKINGS_COLLECTION, eventId));
    if (!snap.exists()) throw new Error("event not found");
    event = { id: snap.id, ...snap.data() };
  } catch (err) {
    content.innerHTML = `<p class="event-list-empty">couldn't load this event — check your internet connection and Firebase config. (${err.message})</p>`;
    return;
  }

  const title = document.getElementById("detail-title");
  const status = document.getElementById("detail-status");
  const subtext = document.getElementById("detail-subtext");

  const state = deriveState(event, new Date());

  if (title) title.textContent = event.title;
  if (status) {
    status.className = `detail-status ${state}`;
  }
  if (subtext) {
    const date = new Date(event.start);
    const stateCopy = state === "live" ? "watch the stream" : state === "upcoming" ? "stream starts soon" : "photo gallery";
    subtext.textContent = `${event.location} · ${formatDateTime(date)} · ${stateCopy}`;
  }

  if (event.imageUrl) {
    const img = document.createElement("img");
    img.className = "detail-image";
    img.src = event.imageUrl;
    img.alt = event.title || "";
    content.appendChild(img);
  }

  if (state === "live") {
    const iframe = document.createElement("iframe");
    iframe.src = event.streamUrl || "https://www.youtube.com/embed/live_stream?channel=UC4R8DWoMoI7CAwX8_LjQHig";
    iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
    iframe.allowFullscreen = true;
    content.appendChild(iframe);
  } else if (state === "upcoming") {
    const notice = document.createElement("p");
    notice.className = "event-list-empty";
    notice.textContent = `this stream hasn't started yet — check back ${formatDateTime(new Date(event.start))}.`;
    content.appendChild(notice);
  } else {
    const gallery = document.createElement("div");
    gallery.className = "detail-gallery";
    const count = Math.max(event.images || 0, 3);
    for (let i = 0; i < count; i += 1) {
      const tile = document.createElement("div");
      tile.className = "image-tile";
      tile.textContent = "🖼";
      gallery.appendChild(tile);
    }
    content.appendChild(gallery);
  }
}

if (document.getElementById("detail-content")) {
  renderDetail();
}
