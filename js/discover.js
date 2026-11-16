// Powers discover.html — the public event browsing page for students.
// Students only; admins who land here get bounced to admin-dashboard.html
// (see the onAuthStateChanged gate at the bottom of this file).
import {
  collection,
  query,
  where,
  getDocs,
  doc,
  getDoc,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { db, auth } from "./firebase-config.js";
import { isAdminEmail } from "./roles.js";

const BOOKINGS_COLLECTION = "bookings";
const USERS_COLLECTION = "users";

const CATEGORIES = ["All Events", "Music & Gig", "Academic Panels", "Club Mixers", "Gaming Nights", "Performing Arts"];

const CATEGORY_META = {
  "Music & Gig": { emoji: "🎵", gradient: "linear-gradient(135deg, #ff6b9d, #845ec2)", image: "assets/category-music-gig.jpg" },
  "Academic Panels": { emoji: "🎓", gradient: "linear-gradient(135deg, #4e8cff, #2a2a6a)" },
  "Club Mixers": { emoji: "🎉", gradient: "linear-gradient(135deg, #ff9a3c, #9f5d2c)", image: "assets/category-club-mixers.jpg" },
  "Gaming Nights": { emoji: "🎮", gradient: "linear-gradient(135deg, #34d399, #1a7a5e)", image: "assets/category-gaming-nights.jpg" },
  "Performing Arts": { emoji: "🎭", gradient: "linear-gradient(135deg, #ff6b6b, #b91c4c)" },
};
const PHOTO_CATEGORIES = ["Music & Gig", "Gaming Nights", "Club Mixers"];

// Deterministic pseudo-random pick, not a real hash — just needs to
// consistently map the same event id to the same fallback category on every
// render (avoids the card's art randomly changing on refresh).
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// Visual fallback for cards/hero when an event has no category (or the
// category isn't one of the ones with defined art). buildEventCard() below
// checks event.imageUrl first and only falls back to this when there's no
// real uploaded photo.
function categoryMeta(event) {
  if (event.category && CATEGORY_META[event.category]) return CATEGORY_META[event.category];
  const fallbackCategory = PHOTO_CATEGORIES[hashString(event.id || event.title || "event") % PHOTO_CATEGORIES.length];
  return CATEGORY_META[fallbackCategory];
}

// "live" isn't a stored field — same derivation as app.js/admin.js, each
// file keeps its own copy rather than sharing a module (no bundler in this
// project to make a shared import convenient).
function deriveState(booking, now) {
  const start = new Date(booking.start);
  const due = new Date(booking.due);
  if (now >= start && now <= due) return "live";
  if (now > due) return "past";
  return "upcoming";
}

function formatEventWhen(startIso) {
  const date = new Date(startIso);
  const now = new Date();
  const timePart = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return `Tonight, ${timePart}`;
  return `${date.toLocaleDateString("en-US", { weekday: "short" })}, ${timePart}`;
}

async function fetchPublishedEvents() {
  const q = query(collection(db, BOOKINGS_COLLECTION), where("status", "==", "published"));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

async function fetchSavedIds(uid) {
  const snap = await getDoc(doc(db, USERS_COLLECTION, uid));
  return snap.exists() ? snap.data().savedEventIds || [] : [];
}

async function toggleSave(uid, eventId, savedIds) {
  const isSaved = savedIds.includes(eventId);
  const next = isSaved ? savedIds.filter((id) => id !== eventId) : [...savedIds, eventId];
  await setDoc(doc(db, USERS_COLLECTION, uid), { savedEventIds: next }, { merge: true });
  return next;
}

function renderProfile(user) {
  const nameEl = document.getElementById("profile-name");
  const avatarEl = document.getElementById("profile-avatar");
  if (nameEl) {
    nameEl.textContent = user.email;
    nameEl.title = user.email;
  }
  if (avatarEl) avatarEl.textContent = user.email.charAt(0).toUpperCase();
}

function initLogout() {
  const link = document.getElementById("logout-link");
  if (!link) return;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    signOut(auth).finally(() => {
      window.location.href = "admin-login.html";
    });
  });
}

function initAccountMenu() {
  const trigger = document.getElementById("account-trigger");
  const menu = document.getElementById("account-menu");
  if (!trigger || !menu) return;

  function close() {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  }

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    const opening = menu.hidden;
    menu.hidden = !opening;
    trigger.setAttribute("aria-expanded", String(opening));
  });

  document.addEventListener("click", (event) => {
    if (!menu.hidden && !menu.contains(event.target) && event.target !== trigger) close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
}

function initMobileMenu() {
  const toggle = document.getElementById("mobile-menu-toggle");
  const panel = document.getElementById("mobile-panel");
  if (!toggle || !panel) return;

  function close() {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  }

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    const opening = panel.hidden;
    panel.hidden = !opening;
    toggle.setAttribute("aria-expanded", String(opening));
  });

  panel.addEventListener("click", (event) => {
    if (event.target.tagName === "A") close();
  });

  document.addEventListener("click", (event) => {
    if (!panel.hidden && !panel.contains(event.target) && event.target !== toggle) close();
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 860) close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
}

// Picks one event to feature at the top of the page: prefer whatever's live
// right now, otherwise the soonest upcoming event. Hides the hero entirely
// if there's nothing live or upcoming (e.g. only past events exist).
function renderHero(events) {
  const section = document.getElementById("discover-hero");
  if (!section) return;
  const now = new Date();
  const withState = events.map((event) => ({ event, state: deriveState(event, now) }));
  const live = withState.find((item) => item.state === "live");
  const nextUpcoming = withState
    .filter((item) => item.state === "upcoming")
    .sort((a, b) => new Date(a.event.start) - new Date(b.event.start))[0];
  const featured = live || nextUpcoming;

  if (!featured) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  const badge = document.getElementById("hero-badge");
  const title = document.getElementById("hero-title");
  const copy = document.getElementById("hero-copy");
  const btn = document.getElementById("hero-btn");
  const btnText = document.getElementById("hero-btn-text");

  if (badge) badge.textContent = featured.state === "live" ? "LIVE NOW" : "COMING UP";
  if (title) title.textContent = featured.event.title;
  if (copy) {
    copy.textContent =
      featured.state === "live"
        ? `Tune into the live campus broadcast from ${featured.event.location}!`
        : `Starts ${formatEventWhen(featured.event.start)} at ${featured.event.location}.`;
  }
  if (btn) btn.href = `event.html?id=${encodeURIComponent(featured.event.id)}`;
  if (btnText) btnText.textContent = featured.state === "live" ? "Join Broadcast" : "View Event";
}

function renderCategories(activeCategory, onSelect) {
  const row = document.getElementById("discover-categories");
  if (!row) return;
  row.innerHTML = "";
  CATEGORIES.forEach((category) => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = `discover-category-pill${category === activeCategory ? " active" : ""}`;
    pill.textContent = category;
    pill.addEventListener("click", () => onSelect(category));
    row.appendChild(pill);
  });
}

function matchesFilters(event, category, search) {
  if (category !== "All Events" && event.category !== category) return false;
  if (!search) return true;
  const haystack = `${event.title} ${event.location} ${event.department} ${event.category || ""}`.toLowerCase();
  return haystack.includes(search.toLowerCase());
}

// Builds one card for the events grid. Hover shows a popup with more detail
// (see showHoverPopup/ensureHoverPopup below) without needing to click
// through to event.html.
function buildEventCard(event, savedIds, onToggleSave) {
  const card = document.createElement("a");
  card.className = "discover-event-card";
  card.href = `event.html?id=${encodeURIComponent(event.id)}`;

  const image = document.createElement("div");
  image.className = "discover-event-image";
  if (event.imageUrl) {
    image.style.backgroundImage = `linear-gradient(rgba(19, 19, 22, 0.15), rgba(19, 19, 22, 0.35)), url("${event.imageUrl}")`;
  } else {
    const meta = categoryMeta(event);
    if (meta.image) {
      image.style.backgroundImage = `linear-gradient(rgba(19, 19, 22, 0.15), rgba(19, 19, 22, 0.35)), url("${meta.image}")`;
    } else {
      image.style.background = meta.gradient;
      image.textContent = meta.emoji;
    }
  }

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  const isSaved = savedIds.includes(event.id);
  saveBtn.className = `discover-save-btn${isSaved ? " saved" : ""}`;
  saveBtn.textContent = isSaved ? "♥" : "♡";
  saveBtn.setAttribute("aria-label", isSaved ? "unsave event" : "save event");
  saveBtn.addEventListener("click", (clickEvent) => {
    clickEvent.preventDefault();
    clickEvent.stopPropagation();
    onToggleSave(event.id);
  });
  image.appendChild(saveBtn);

  const text = document.createElement("div");
  text.className = "discover-card-text";

  const title = document.createElement("p");
  title.className = "discover-card-title";
  title.textContent = event.title;

  const location = document.createElement("p");
  location.className = "discover-card-location";
  location.textContent = event.location;

  const time = document.createElement("p");
  time.className = "discover-card-time";
  time.textContent = formatEventWhen(event.start);

  text.append(title, location, time);
  card.append(image, text);

  card.addEventListener("mouseenter", () => showHoverPopup(event, card));
  card.addEventListener("mouseleave", hideHoverPopup);

  return card;
}

// Single shared popup element reused across every card (created once, moved
// around on hover) rather than one per card — cheaper than duplicating this
// markup for every event in the grid.
function ensureHoverPopup() {
  let popup = document.getElementById("discover-hover-popup");
  if (popup) return popup;
  popup = document.createElement("div");
  popup.id = "discover-hover-popup";
  popup.className = "discover-hover-popup";
  popup.innerHTML = `
    <p class="discover-hover-popup-desc"></p>
    <div class="discover-hover-popup-row location"><img src="assets/location-badge-icon.svg" alt="" aria-hidden="true" /><span class="text"></span></div>
    <div class="discover-hover-popup-row time"><img src="assets/clock-badge-icon.svg" alt="" aria-hidden="true" /><span class="text"></span></div>
    <div class="discover-hover-popup-row attendance"><img src="assets/people-badge-icon.svg" alt="" aria-hidden="true" /><span class="text"></span></div>
    <hr class="discover-hover-popup-divider" />
    <div class="discover-hover-popup-organizer">
      <span class="discover-hover-popup-organizer-label">Organized by</span>
      <span class="discover-hover-popup-organizer-name"></span>
    </div>
  `;
  document.body.appendChild(popup);
  window.addEventListener("scroll", hideHoverPopup, true);
  return popup;
}

// Centers the popup over the hovered card, clamped so it never runs off the
// viewport edges; flips to below the card if there isn't room above it.
function positionHoverPopup(popup, cardRect) {
  const margin = 12;
  const popupWidth = popup.offsetWidth || 320;
  let left = cardRect.left + cardRect.width / 2 - popupWidth / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - popupWidth - margin));

  const popupHeight = popup.offsetHeight || 220;
  let top = cardRect.top - popupHeight - margin;
  if (top < margin) top = cardRect.bottom + margin;

  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

function showHoverPopup(event, cardEl) {
  const popup = ensureHoverPopup();
  popup.querySelector(".discover-hover-popup-desc").textContent = event.objective || "No description provided.";
  popup.querySelector(".location .text").textContent = event.location;
  popup.querySelector(".time .text").textContent = formatEventWhen(event.start);
  popup.querySelector(".attendance .text").textContent = event.audience || "Attendance not specified";
  popup.querySelector(".discover-hover-popup-organizer-name").textContent = event.department || event.organizer || "AIC LiveHub";

  popup.classList.add("visible");
  positionHoverPopup(popup, cardEl.getBoundingClientRect());
}

function hideHoverPopup() {
  const popup = document.getElementById("discover-hover-popup");
  if (popup) popup.classList.remove("visible");
}

function renderEventsGrid(events, category, search, savedIds, onToggleSave) {
  const grid = document.getElementById("discover-events-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const filtered = events.filter((event) => matchesFilters(event, category, search)).sort((a, b) => new Date(a.start) - new Date(b.start));

  if (filtered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "discover-empty";
    empty.textContent = "nothing matches that search yet — try another filter.";
    grid.appendChild(empty);
    return;
  }

  filtered.forEach((event) => grid.appendChild(buildEventCard(event, savedIds, onToggleSave)));
}

// Entry point once the user is confirmed to be a signed-in, non-admin
// student (see the gate at the bottom of this file). Owns the page's
// filter/search state in closures, since there's no framework/store here.
async function initDiscover(user) {
  renderProfile(user);
  initLogout();
  initAccountMenu();
  initMobileMenu();

  let events = [];
  let savedIds = [];
  let activeCategory = "All Events";
  let searchQuery = "";

  function renderGrid() {
    renderEventsGrid(events, activeCategory, searchQuery, savedIds, handleToggleSave);
  }

  async function handleToggleSave(eventId) {
    try {
      savedIds = await toggleSave(user.uid, eventId, savedIds);
      renderGrid();
    } catch (err) {
      window.alert(`couldn't save that: ${err.message}`);
    }
  }

  function onCategorySelect(category) {
    activeCategory = category;
    renderCategories(activeCategory, onCategorySelect);
    renderGrid();
  }

  renderCategories(activeCategory, onCategorySelect);

  const searchInput = document.getElementById("discover-search-input");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      searchQuery = searchInput.value.trim();
      renderGrid();
    });
  }

  try {
    events = await fetchPublishedEvents();
    renderHero(events);
    renderGrid();
  } catch (err) {
    const grid = document.getElementById("discover-events-grid");
    if (grid) {
      grid.innerHTML = "";
      const notice = document.createElement("p");
      notice.className = "discover-empty";
      notice.textContent = `can't reach Firestore — check your internet connection and Firebase config. (${err.message})`;
      grid.appendChild(notice);
    }
  }

  try {
    savedIds = await fetchSavedIds(user.uid);
    renderGrid();
  } catch (err) {
    console.warn("couldn't load saved events:", err);
  }
}

// Only runs this page's logic if the expected root element exists — lets
// discover.js (and every other page's script) be loaded on any page without
// erroring, since they all import shared helpers from the same files.
if (document.getElementById("discover-events-grid")) {
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      window.location.replace("admin-login.html");
      return;
    }
    if (isAdminEmail(user.email)) {
      window.location.replace("admin-dashboard.html");
      return;
    }
    document.body.classList.remove("auth-pending");
    initDiscover(user);
  });
}
