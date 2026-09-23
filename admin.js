import {
  collection,
  getDocs,
  doc,
  updateDoc,
  addDoc,
  deleteDoc,
  query,
  orderBy,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { db, auth } from "./firebase-config.js";
import { isAdminEmail } from "./roles.js";

// Dual-purpose file: powers BOTH admin-login.html (initLoginForm and friends,
// near the bottom) and admin-dashboard.html (everything else). Which parts
// actually run is decided by which DOM elements exist on the current page —
// see the `if (document.getElementById(...))` gates scattered through this
// file rather than a single router.
const BOOKINGS_COLLECTION = "bookings";

// Not a real secret — this file ships to the browser, so anyone can read it from
// page source. It only deters casual/scripted abuse of the email endpoint, same
// tier of protection as the Firebase client config above. Must match the
// APP_SHARED_SECRET env var set on the Vercel project.
const APP_SHARED_SECRET = "dbyajSLW9f-Y0gUdR1j4rDJObbv7x8KN";

async function sendEmail(type, booking, link) {
  try {
    const res = await fetch("/api/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-app-secret": APP_SHARED_SECRET },
      body: JSON.stringify({ type, booking, link }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (err) {
    console.warn(`Event was published, but the "${type}" email failed to send:`, err.message);
  }
}

// readAsDataURL gives "data:image/png;base64,AAAA..." — only the part after
// the comma is the actual base64 payload the API endpoint wants.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Sends the file to /api/upload-image (Vercel Blob under the hood — see
// api/upload-image.js) and returns the public URL to store as imageUrl.
async function uploadImage(file) {
  const dataBase64 = await fileToBase64(file);
  const res = await fetch("/api/upload-image", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-app-secret": APP_SHARED_SECRET },
    body: JSON.stringify({ filename: file.name, contentType: file.type, dataBase64 }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `status ${res.status}`);
  return data.url;
}

const ICONS = {
  location: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`,
  video: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m23 7-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`,
  link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
};

const PLATFORM_LABELS = { youtube: "YouTube", zoom: "Zoom", MSTeams: "Microsoft Teams" };
const STATUS_LABEL = { pending: "Pending", approved: "Approved", rejected: "Rejected", published: "Published" };

const REQUEST_TABS = [
  { id: "pending", label: "Pending requests" },
  { id: "approved", label: "Approved — not live yet" },
  { id: "published", label: "Published events" },
  { id: "rejected", label: "Rejected" },
];

let bookingRequests = [];
let requestTab = "pending";
let publishedSearch = "";
let publishedStatusFilter = "all";
let currentUser = null;

let publishPicker = null;
let publishBooking = null;

let reschedulePicker = null;
let rescheduleBooking = null;

function platformLabel(platform) {
  return PLATFORM_LABELS[platform] || platform || "—";
}

function shortLink(url) {
  return url.replace(/^https?:\/\//, "");
}

function organizerLine(request) {
  const who = request.organizer || request.organizerType || "Organizer";
  const dept = request.department ? ` · ${request.department}` : "";
  return `${who}${dept}`;
}

// Formats a Date back into flatpickr's "Y-m-d\TH:i" string, in LOCAL time.
// Deliberately not using toISOString() here — that converts to UTC, which
// would silently shift the displayed time by the browser's timezone offset.
// Used when the publish/reschedule modals recompute `due` after the admin
// changes `start` (see initPublishModal/initRescheduleModal below).
function toFlatpickrValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// "live" isn't a stored field — same derivation duplicated in app.js and
// discover.js (each file keeps its own copy; no shared module/bundler here).
function deriveState(booking, now) {
  const start = new Date(booking.start);
  const due = new Date(booking.due);
  if (now >= start && now <= due) return "live";
  if (now > due) return "past";
  return "upcoming";
}

// Published events show as "Scheduled" (blue) until their start time
// arrives, then "Published" (green) for both live and past — there's no
// separate stored status for this, it's purely derived from the clock.
function publishedBadge(request) {
  const state = deriveState(request, new Date());
  return state === "upcoming" ? { label: "Scheduled", cls: "scheduled" } : { label: "Published", cls: "published" };
}

function formatRange(startIso, dueIso) {
  const start = new Date(startIso);
  const due = new Date(dueIso);
  const startStr = start.toLocaleString("en-US", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const dueStr = due.toLocaleString("en-US", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  return `${startStr} → ${dueStr}`;
}

/* ---------- comments ---------- */

function commentsCollection(bookingId) {
  return collection(db, BOOKINGS_COLLECTION, bookingId, "comments");
}

async function fetchComments(bookingId) {
  const q = query(commentsCollection(bookingId), orderBy("createdAt", "asc"));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

async function postComment(bookingId, text) {
  await addDoc(commentsCollection(bookingId), {
    text,
    authorUid: currentUser.uid,
    authorEmail: currentUser.email,
    createdAt: serverTimestamp(),
  });
}

function formatCommentTime(timestamp) {
  if (!timestamp) return "just now";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return date.toLocaleString("en-US", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

function buildCommentsSection(bookingId) {
  const wrap = document.createElement("div");
  wrap.className = "admin-light-comments";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "admin-light-comments-toggle";
  toggle.textContent = "Comments";
  wrap.appendChild(toggle);

  const panel = document.createElement("div");
  panel.className = "admin-light-comments-panel";
  panel.hidden = true;
  wrap.appendChild(panel);

  const list = document.createElement("div");
  list.className = "admin-light-comments-list";
  panel.appendChild(list);

  const form = document.createElement("form");
  form.className = "admin-light-comments-form";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Write a comment…";
  input.required = true;
  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.textContent = "Send";
  form.append(input, submitBtn);
  panel.appendChild(form);

  function renderComments(comments) {
    list.innerHTML = "";
    if (comments.length === 0) {
      const empty = document.createElement("p");
      empty.className = "admin-light-comments-empty";
      empty.textContent = "No comments yet.";
      list.appendChild(empty);
      return;
    }
    comments.forEach((comment) => {
      const item = document.createElement("div");
      const meta = document.createElement("p");
      meta.className = "admin-light-comment-meta";
      meta.innerHTML = `<strong>${comment.authorEmail}</strong> · ${formatCommentTime(comment.createdAt)}`;
      const text = document.createElement("p");
      text.className = "admin-light-comment-text";
      text.textContent = comment.text;
      item.append(meta, text);
      list.appendChild(item);
    });
    list.scrollTop = list.scrollHeight;
  }

  let loaded = false;
  async function loadComments() {
    list.innerHTML = `<p class="admin-light-comments-empty">Loading…</p>`;
    try {
      renderComments(await fetchComments(bookingId));
      loaded = true;
    } catch (err) {
      list.innerHTML = `<p class="admin-light-comments-empty">Couldn't load comments: ${err.message}</p>`;
    }
  }

  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden && !loaded) loadComments();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    submitBtn.disabled = true;
    try {
      await postComment(bookingId, text);
      input.value = "";
      await loadComments();
    } catch (err) {
      window.alert(`Couldn't post that comment: ${err.message}`);
    } finally {
      submitBtn.disabled = false;
    }
  });

  return wrap;
}

/* ---------- data ---------- */

async function fetchBookings() {
  const snapshot = await getDocs(collection(db, BOOKINGS_COLLECTION));
  return snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

async function patchBooking(id, patch) {
  await updateDoc(doc(db, BOOKINGS_COLLECTION, id), patch);
}

async function createBooking(booking) {
  const docRef = await addDoc(collection(db, BOOKINGS_COLLECTION), booking);
  return { id: docRef.id, ...booking };
}

async function deleteBooking(id) {
  await deleteDoc(doc(db, BOOKINGS_COLLECTION, id));
}

function showApiError(message) {
  const list = document.getElementById("request-list");
  if (!list) return;
  list.innerHTML = `<p class="admin-light-empty">${message}</p>`;
}

async function notifyOrganizerPublished(request) {
  const eventLink = `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, "")}event.html?id=${encodeURIComponent(request.id)}`;
  await sendEmail("organizer_published", request, eventLink);
}

async function setStatus(id, status) {
  const request = bookingRequests.find((r) => r.id === id);
  if (!request) return;
  const previousStatus = request.status;
  request.status = status;
  renderStats();
  renderRequestList();
  renderPublishedList();

  try {
    await patchBooking(id, { status });
  } catch (err) {
    request.status = previousStatus;
    renderStats();
    renderRequestList();
    renderPublishedList();
    window.alert(`Couldn't save that change: ${err.message}`);
  }
}

/* ---------- stats + tabs ---------- */

function renderStats() {
  const el = document.getElementById("admin-stats");
  if (!el) return;

  const counts = { pending: 0, approved: 0, published: 0, rejected: 0 };
  bookingRequests.forEach((r) => {
    if (counts[r.status] !== undefined) counts[r.status] += 1;
  });

  const cards = [
    { key: "pending", label: "pending review", value: counts.pending },
    { key: "approved", label: "approved, not live yet", value: counts.approved },
    { key: "published", label: "published", value: counts.published },
    { key: "rejected", label: "rejected", value: counts.rejected },
  ];

  el.innerHTML = "";
  cards.forEach((card) => {
    const div = document.createElement("div");
    div.className = `admin-light-stat ${card.key}`;
    div.innerHTML = `<div class="admin-light-stat-count">${card.value}</div><p class="admin-light-stat-label">${card.label}</p>`;
    el.appendChild(div);
  });
}

function renderRequestTabs() {
  const row = document.getElementById("request-tabs");
  if (!row) return;
  row.innerHTML = "";
  REQUEST_TABS.forEach((tab) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `admin-light-tab${tab.id === requestTab ? " active" : ""}`;
    btn.textContent = tab.label;
    btn.addEventListener("click", () => {
      requestTab = tab.id;
      renderRequestTabs();
      renderRequestList();
    });
    row.appendChild(btn);
  });
}

/* ---------- manage booking requests ---------- */

function buildRequestActions(request) {
  const wrap = document.createElement("div");
  wrap.className = "admin-light-card-actions";

  if (request.status === "pending") {
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "admin-light-btn solid-success";
    approve.textContent = "Approve";
    approve.addEventListener("click", () => setStatus(request.id, "approved"));

    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "admin-light-btn text-danger";
    reject.textContent = "Reject";
    reject.addEventListener("click", () => setStatus(request.id, "rejected"));

    wrap.append(approve, reject);
  } else if (request.status === "approved") {
    const publish = document.createElement("button");
    publish.type = "button";
    publish.className = "admin-light-btn solid-primary";
    publish.textContent = "Publish";
    publish.addEventListener("click", () => openPublishModal(request));
    wrap.append(publish);
  } else if (request.status === "rejected") {
    const reconsider = document.createElement("button");
    reconsider.type = "button";
    reconsider.className = "admin-light-btn outline";
    reconsider.textContent = "Reconsider";
    reconsider.addEventListener("click", () => setStatus(request.id, "pending"));
    wrap.append(reconsider);
  } else if (request.status === "published") {
    const manage = document.createElement("button");
    manage.type = "button";
    manage.className = "admin-light-btn outline";
    manage.textContent = "Manage in Published Events";
    manage.addEventListener("click", () => document.querySelector('.admin-light-nav-link[data-view="published"]').click());
    wrap.append(manage);
  }

  return wrap;
}

function buildRequestCard(request) {
  const card = document.createElement("article");
  card.className = `admin-light-card status-${request.status}`;

  const body = document.createElement("div");
  body.className = "admin-light-card-body";

  const titleRow = document.createElement("div");
  titleRow.className = "admin-light-card-title-row";
  titleRow.innerHTML = `
    <h3 class="admin-light-card-title">${request.title}</h3>
    <span class="admin-light-badge ${request.status}">${STATUS_LABEL[request.status]}</span>
  `;

  const organizer = document.createElement("p");
  organizer.className = "admin-light-card-organizer";
  organizer.innerHTML = `<strong>${organizerLine(request)}</strong> · ${request.organizerEmail || "—"}`;

  const metaGrid = document.createElement("div");
  metaGrid.className = "admin-light-card-meta-grid";
  metaGrid.innerHTML = `
    <div class="admin-light-meta-item">
      <span class="admin-light-meta-label">Venue</span>
      <span class="admin-light-meta-value">${ICONS.location}${request.location || "—"}</span>
    </div>
    <div class="admin-light-meta-item">
      <span class="admin-light-meta-label">Date and time</span>
      <span class="admin-light-meta-value">${ICONS.calendar}${formatRange(request.start, request.due)}</span>
    </div>
    <div class="admin-light-meta-item">
      <span class="admin-light-meta-label">Livestream</span>
      <span class="admin-light-meta-value">${ICONS.video}${platformLabel(request.platform)}</span>
    </div>
    <div class="admin-light-meta-item">
      <span class="admin-light-meta-label">Audience</span>
      <span class="admin-light-meta-value">${request.audience || "—"}</span>
    </div>
  `;

  const notesLabel = document.createElement("p");
  notesLabel.className = "admin-light-card-notes-label";
  notesLabel.textContent = "Organizer comments";
  const notes = document.createElement("p");
  notes.className = "admin-light-card-notes";
  notes.textContent = request.objective || "—";

  body.append(titleRow, organizer, metaGrid, notesLabel, notes, buildCommentsSection(request.id));
  card.append(body, buildRequestActions(request));
  return card;
}

function renderRequestList() {
  const list = document.getElementById("request-list");
  if (!list) return;

  const items = bookingRequests.filter((r) => r.status === requestTab);
  list.innerHTML = "";

  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "admin-light-empty";
    empty.textContent = "No requests in this view.";
    list.appendChild(empty);
    return;
  }

  items.forEach((request) => list.appendChild(buildRequestCard(request)));
}

/* ---------- published events ---------- */

function buildPublishedCard(request) {
  const badge = publishedBadge(request);
  const card = document.createElement("article");
  card.className = `admin-light-card status-${badge.cls}`;

  const img = document.createElement("img");
  img.className = "admin-light-card-image";
  img.src = request.imageUrl || "assets/yellow-glow.svg";
  img.alt = "";

  const body = document.createElement("div");
  body.className = "admin-light-card-body";

  const titleRow = document.createElement("div");
  titleRow.className = "admin-light-card-title-row";
  titleRow.innerHTML = `<h3 class="admin-light-card-title">${request.title}</h3>`;

  const organizer = document.createElement("p");
  organizer.className = "admin-light-card-organizer";
  organizer.textContent = `${organizerLine(request)} · ${request.organizerEmail || "—"}`;

  const linkHtml = request.streamUrl
    ? `<a href="${request.streamUrl}" target="_blank" rel="noopener">${shortLink(request.streamUrl)}</a>`
    : "—";

  const metaGrid = document.createElement("div");
  metaGrid.className = "admin-light-card-meta-grid";
  metaGrid.innerHTML = `
    <div class="admin-light-meta-item">
      <span class="admin-light-meta-label">Venue</span>
      <span class="admin-light-meta-value">${ICONS.location}${request.location || "—"}</span>
    </div>
    <div class="admin-light-meta-item">
      <span class="admin-light-meta-label">Date and time</span>
      <span class="admin-light-meta-value">${ICONS.calendar}${formatRange(request.start, request.due)}</span>
    </div>
    <div class="admin-light-meta-item">
      <span class="admin-light-meta-label">Livestream</span>
      <span class="admin-light-meta-value">${ICONS.video}${platformLabel(request.platform)}</span>
    </div>
    <div class="admin-light-meta-item">
      <span class="admin-light-meta-label">Meeting link</span>
      <span class="admin-light-meta-value">${ICONS.link}${linkHtml}</span>
    </div>
  `;

  const notesLabel = document.createElement("p");
  notesLabel.className = "admin-light-card-notes-label";
  notesLabel.textContent = "Organizer comments";
  const notes = document.createElement("p");
  notes.className = "admin-light-card-notes";
  notes.textContent = request.objective || "—";

  body.append(titleRow, organizer, metaGrid, notesLabel, notes, buildCommentsSection(request.id));

  const side = document.createElement("div");
  side.className = "admin-light-card-side";

  const badgeEl = document.createElement("span");
  badgeEl.className = `admin-light-badge ${badge.cls}`;
  badgeEl.textContent = badge.label;

  const actions = document.createElement("div");
  actions.className = "admin-light-card-actions";

  const reschedule = document.createElement("button");
  reschedule.type = "button";
  reschedule.className = "admin-light-btn outline";
  reschedule.textContent = "Reschedule";
  reschedule.addEventListener("click", () => openRescheduleModal(request));

  const deactivate = document.createElement("button");
  deactivate.type = "button";
  deactivate.className = "admin-light-btn text-warning";
  deactivate.textContent = "Deactivate";
  deactivate.addEventListener("click", () => {
    openConfirmModal({
      title: "Deactivate this event?",
      message: `"${request.title}" will be removed from the public calendar and moved back to approved, not-live.`,
      onConfirm: () => setStatus(request.id, "approved"),
    });
  });

  const del = document.createElement("button");
  del.type = "button";
  del.className = "admin-light-btn text-danger";
  del.textContent = "Delete";
  del.addEventListener("click", () => {
    openConfirmModal({
      title: "Delete this event?",
      message: `"${request.title}" will be permanently deleted. This can't be undone.`,
      onConfirm: async () => {
        try {
          await deleteBooking(request.id);
          bookingRequests = bookingRequests.filter((r) => r.id !== request.id);
          renderStats();
          renderRequestList();
          renderPublishedList();
        } catch (err) {
          window.alert(`Couldn't delete that event: ${err.message}`);
        }
      },
    });
  });

  actions.append(reschedule, deactivate, del);
  side.append(badgeEl, actions);

  card.append(img, body, side);
  return card;
}

function renderPublishedList() {
  const list = document.getElementById("published-list");
  if (!list) return;

  let items = bookingRequests.filter((r) => r.status === "published");

  if (publishedStatusFilter !== "all") {
    items = items.filter((r) => publishedBadge(r).cls === publishedStatusFilter);
  }
  if (publishedSearch.trim()) {
    const q = publishedSearch.trim().toLowerCase();
    items = items.filter((r) =>
      [r.title, r.organizer, r.organizerType, r.organizerEmail, r.location].some((v) => (v || "").toLowerCase().includes(q))
    );
  }

  items.sort((a, b) => new Date(a.start) - new Date(b.start));

  list.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "admin-light-empty";
    empty.textContent = "Nothing published yet.";
    list.appendChild(empty);
    return;
  }
  items.forEach((request) => list.appendChild(buildPublishedCard(request)));
}

/* ---------- confirm modal ---------- */

// Generic yes/no confirmation dialog reused for both Deactivate and Delete —
// caller supplies the copy and what happens on confirm, this just handles
// showing/hiding the shared overlay and wiring/unwiring the buttons each
// time so listeners don't pile up across repeated opens.
function openConfirmModal({ title, message, onConfirm }) {
  const overlay = document.getElementById("confirm-overlay");
  const titleEl = document.getElementById("confirm-title");
  const msgEl = document.getElementById("confirm-message");
  const okBtn = document.getElementById("confirm-ok");
  const cancelBtn = document.getElementById("confirm-cancel");
  if (!overlay) return;

  titleEl.textContent = title;
  msgEl.textContent = message;
  overlay.hidden = false;

  function cleanup() {
    overlay.hidden = true;
    okBtn.removeEventListener("click", handleOk);
    cancelBtn.removeEventListener("click", handleCancel);
  }
  function handleOk() {
    cleanup();
    onConfirm();
  }
  function handleCancel() {
    cleanup();
  }
  okBtn.addEventListener("click", handleOk);
  cancelBtn.addEventListener("click", handleCancel);
}

/* ---------- publish modal ---------- */

function initPublishModal() {
  const overlay = document.getElementById("publish-overlay");
  const form = document.getElementById("publish-form");
  const cancelBtn = document.getElementById("publish-cancel");
  const uploadZone = document.getElementById("publish-upload-zone");
  const imageInput = document.getElementById("publish-image-input");
  const imageUrlInput = document.getElementById("publish-image-url");
  const hint = document.getElementById("publish-upload-hint");
  const errorEl = document.getElementById("publish-error");
  if (!overlay || !form) return;

  if (window.flatpickr) {
    publishPicker = window.flatpickr("#publish-start", {
      enableTime: true,
      dateFormat: "Y-m-d\\TH:i",
      altInput: true,
      altFormat: "F j, Y — h:i K",
    });
  }

  imageUrlInput.addEventListener("input", () => {
    updatePublishPreview(imageUrlInput.value.trim(), uploadZone, hint);
  });

  imageInput.addEventListener("change", async () => {
    const file = imageInput.files?.[0];
    if (!file) return;
    hint.textContent = "Uploading…";
    try {
      const url = await uploadImage(file);
      imageUrlInput.value = url;
      updatePublishPreview(url, uploadZone, hint);
    } catch (err) {
      hint.textContent = `Couldn't upload: ${err.message}`;
    } finally {
      imageInput.value = "";
    }
  });

  cancelBtn.addEventListener("click", closePublishModal);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!publishBooking) return;
    errorEl.hidden = true;
    const submitBtn = document.getElementById("publish-submit");
    submitBtn.disabled = true;

    const startValue = document.getElementById("publish-start").value;
    if (!startValue) {
      errorEl.textContent = "Pick a date & time.";
      errorEl.hidden = false;
      submitBtn.disabled = false;
      return;
    }

    // The modal only lets the admin pick a new start time, not a separate
    // due time — so if start changes, shift `due` by the same amount to
    // preserve the original event duration rather than leaving a stale due
    // date that could end up before the new start.
    let dueValue = publishBooking.due;
    if (publishBooking.start && publishBooking.due) {
      const duration = new Date(publishBooking.due) - new Date(publishBooking.start);
      dueValue = toFlatpickrValue(new Date(new Date(startValue).getTime() + duration));
    }

    const patch = {
      title: document.getElementById("publish-title").value.trim(),
      start: startValue,
      due: dueValue,
      location: document.getElementById("publish-venue").value.trim(),
      audience: document.getElementById("publish-audience").value.trim(),
      imageUrl: document.getElementById("publish-image-url").value.trim(),
      status: "published",
    };

    try {
      const previousStatus = publishBooking.status;
      await patchBooking(publishBooking.id, patch);
      Object.assign(publishBooking, patch);
      renderStats();
      renderRequestList();
      renderPublishedList();
      closePublishModal();
      if (previousStatus !== "published") {
        await notifyOrganizerPublished(publishBooking);
      }
    } catch (err) {
      errorEl.textContent = `Couldn't publish: ${err.message}`;
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });
}

function openPublishModal(request) {
  publishBooking = request;
  const overlay = document.getElementById("publish-overlay");
  const errorEl = document.getElementById("publish-error");
  const uploadZone = document.getElementById("publish-upload-zone");
  const hint = document.getElementById("publish-upload-hint");
  const imageUrlInput = document.getElementById("publish-image-url");
  errorEl.hidden = true;
  imageUrlInput.value = request.imageUrl || "";
  updatePublishPreview(imageUrlInput.value.trim(), uploadZone, hint);

  document.getElementById("publish-title").value = request.title || "";
  document.getElementById("publish-venue").value = request.location || "";
  document.getElementById("publish-audience").value = request.audience || "";
  if (publishPicker) {
    publishPicker.setDate(request.start || null, true);
  } else {
    document.getElementById("publish-start").value = request.start || "";
  }
  overlay.hidden = false;
}

// Swaps the upload zone between its empty state (icon + hint) and preview
// state (the chosen/pasted image). Uses style.display rather than the
// `hidden` property on the icon — `svg.hidden = true` doesn't reliably
// reflect to the content attribute for SVG elements, so it silently does
// nothing; style.display works regardless of element type.
function updatePublishPreview(url, uploadZone, hint) {
  uploadZone.querySelector("img")?.remove();
  const icon = uploadZone.querySelector("svg");
  if (url) {
    const img = document.createElement("img");
    img.src = url;
    uploadZone.prepend(img);
    hint.textContent = "Click to replace this photo";
    if (icon) icon.style.display = "none";
  } else {
    hint.textContent = "Click to upload an event photo (optional)";
    if (icon) icon.style.display = "";
  }
}

function closePublishModal() {
  document.getElementById("publish-overlay").hidden = true;
  publishBooking = null;
}

/* ---------- reschedule modal ---------- */

function initRescheduleModal() {
  const overlay = document.getElementById("reschedule-overlay");
  const form = document.getElementById("reschedule-form");
  const cancelBtn = document.getElementById("reschedule-cancel");
  const errorEl = document.getElementById("reschedule-error");
  if (!overlay || !form) return;

  if (window.flatpickr) {
    reschedulePicker = window.flatpickr("#reschedule-start", {
      enableTime: true,
      dateFormat: "Y-m-d\\TH:i",
      altInput: true,
      altFormat: "F j, Y — h:i K",
    });
  }

  cancelBtn.addEventListener("click", closeRescheduleModal);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!rescheduleBooking) return;
    errorEl.hidden = true;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    const startValue = document.getElementById("reschedule-start").value;
    if (!startValue) {
      errorEl.textContent = "Pick a date & time.";
      errorEl.hidden = false;
      submitBtn.disabled = false;
      return;
    }

    let dueValue = rescheduleBooking.due;
    if (rescheduleBooking.start && rescheduleBooking.due) {
      const duration = new Date(rescheduleBooking.due) - new Date(rescheduleBooking.start);
      dueValue = toFlatpickrValue(new Date(new Date(startValue).getTime() + duration));
    }

    const patch = {
      start: startValue,
      due: dueValue,
      location: document.getElementById("reschedule-venue").value.trim(),
    };

    try {
      await patchBooking(rescheduleBooking.id, patch);
      Object.assign(rescheduleBooking, patch);
      renderRequestList();
      renderPublishedList();
      closeRescheduleModal();
    } catch (err) {
      errorEl.textContent = `Couldn't save changes: ${err.message}`;
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });
}

function openRescheduleModal(request) {
  rescheduleBooking = request;
  const overlay = document.getElementById("reschedule-overlay");
  document.getElementById("reschedule-venue").value = request.location || "";
  if (reschedulePicker) {
    reschedulePicker.setDate(request.start || null, true);
  } else {
    document.getElementById("reschedule-start").value = request.start || "";
  }
  document.getElementById("reschedule-error").hidden = true;
  overlay.hidden = false;
}

function closeRescheduleModal() {
  document.getElementById("reschedule-overlay").hidden = true;
  rescheduleBooking = null;
}

/* ---------- view switching + new request form ---------- */

function initViewSwitching() {
  const navLinks = document.querySelectorAll(".admin-light-nav-link[data-view]");
  const views = {
    requests: document.getElementById("view-requests"),
    new: document.getElementById("view-new"),
    published: document.getElementById("view-published"),
  };

  navLinks.forEach((link) => {
    link.addEventListener("click", () => {
      const target = link.dataset.view;
      navLinks.forEach((l) => l.classList.toggle("active", l === link));
      Object.entries(views).forEach(([key, section]) => {
        if (section) section.hidden = key !== target;
      });
    });
  });
}

function initDateTimePickers() {
  if (!window.flatpickr) return {};
  const opts = {
    enableTime: true,
    dateFormat: "Y-m-d\\TH:i",
    altInput: true,
    altFormat: "F j, Y — h:i K",
  };
  return {
    start: window.flatpickr("#field-start", opts),
    due: window.flatpickr("#field-due", opts),
  };
}

function initNewRequestForm() {
  const form = document.getElementById("new-request-form");
  if (!form) return;

  const pickers = initDateTimePickers();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const submitBtn = form.querySelector('button[type="submit"]');
    const audienceValue = document.getElementById("field-audience").value;
    const booking = {
      title: document.getElementById("field-title").value.trim(),
      organizerType: document.getElementById("field-organizer-type").value,
      organizerEmail: document.getElementById("field-organizer-email").value.trim(),
      department: document.getElementById("field-department").value.trim(),
      location: document.getElementById("field-location").value.trim(),
      start: document.getElementById("field-start").value,
      due: document.getElementById("field-due").value,
      platform: document.getElementById("field-platform").value,
      category: document.getElementById("field-category").value,
      audience: audienceValue ? Number(audienceValue) : "",
      objective: document.getElementById("field-objective").value.trim(),
      status: "pending",
      streamUrl: document.getElementById("field-stream-url").value.trim(),
      images: 0,
    };

    if (!booking.start || !booking.due) {
      window.alert("Pick a start and due date & time.");
      return;
    }

    if (submitBtn) submitBtn.disabled = true;
    try {
      const saved = await createBooking(booking);
      bookingRequests.push(saved);
      form.reset();
      pickers.start?.clear();
      pickers.due?.clear();

      requestTab = "pending";
      renderRequestTabs();
      renderStats();
      renderRequestList();

      document.querySelector('.admin-light-nav-link[data-view="requests"]').click();
    } catch (err) {
      window.alert(`Couldn't submit that request: ${err.message}`);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

// --- Everything below this point is the admin-login.html side of this
// file — form handling, password visibility, the student/staff tab toggle,
// and password reset. The gate at the very bottom decides which parts of
// this whole file actually do anything on a given page. ---

function redirectAfterAuth(email) {
  window.location.href = isAdminEmail(email) ? "admin-dashboard.html" : "discover.html";
}

function initLoginForm() {
  const form = document.getElementById("login-form");
  if (!form) return;
  const errorEl = document.getElementById("login-error");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (errorEl) errorEl.hidden = true;
    const email = document.getElementById("field-email").value.trim();
    const password = document.getElementById("field-password").value;
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const credential = await signInWithEmailAndPassword(auth, email, password);
      redirectAfterAuth(credential.user.email);
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = "incorrect email or password. check with your student hub coordinator.";
        errorEl.classList.remove("success");
        errorEl.hidden = false;
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

function initPasswordToggle() {
  const toggle = document.getElementById("toggle-password");
  const input = document.getElementById("field-password");
  const icon = toggle?.querySelector("img");
  if (!toggle || !input) return;
  toggle.addEventListener("click", () => {
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    toggle.setAttribute("aria-label", showing ? "show password" : "hide password");
    if (icon) icon.src = showing ? "assets/eye-icon.svg" : "assets/eye-off-icon.svg";
  });
}

function initRoleTabs() {
  const studentTab = document.getElementById("tab-student");
  const staffTab = document.getElementById("tab-staff");
  if (!studentTab || !staffTab) return;
  [studentTab, staffTab].forEach((tab) => {
    tab.addEventListener("click", () => {
      [studentTab, staffTab].forEach((t) => {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", String(t === tab));
      });
    });
  });
}

function initForgotPassword() {
  const link = document.getElementById("forgot-password-link");
  const emailField = document.getElementById("field-email");
  const errorEl = document.getElementById("login-error");
  if (!link) return;

  link.addEventListener("click", async (event) => {
    event.preventDefault();
    const email = (emailField?.value || "").trim() || window.prompt("Enter your email to reset your password:");
    if (!email) return;

    try {
      await sendPasswordResetEmail(auth, email);
      if (errorEl) {
        errorEl.textContent = `password reset email sent to ${email} — check your inbox.`;
        errorEl.classList.add("success");
        errorEl.hidden = false;
      }
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = `couldn't send that: ${err.message}`;
        errorEl.classList.remove("success");
        errorEl.hidden = false;
      }
    }
  });
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

async function initDashboard() {
  renderRequestTabs();
  initViewSwitching();
  initNewRequestForm();
  initLogout();
  initPublishModal();
  initRescheduleModal();

  const nameEl = document.getElementById("profile-name");
  const avatarEl = document.getElementById("profile-avatar");
  if (currentUser) {
    if (nameEl) nameEl.textContent = currentUser.email;
    if (avatarEl) avatarEl.textContent = currentUser.email.charAt(0).toUpperCase();
  }

  document.getElementById("published-search")?.addEventListener("input", (event) => {
    publishedSearch = event.target.value;
    renderPublishedList();
  });
  document.getElementById("published-status-filter")?.addEventListener("change", (event) => {
    publishedStatusFilter = event.target.value;
    renderPublishedList();
  });

  try {
    bookingRequests = await fetchBookings();
    renderStats();
    renderRequestList();
    renderPublishedList();
  } catch (err) {
    showApiError(`Can't reach Firestore — check your internet connection and Firebase config. (${err.message})`);
  }
}

// Dashboard gate — only runs on admin-dashboard.html (detected by the stats
// element existing). Bounces signed-out users to login and non-admin users
// to discover.html, mirroring the equivalent gates in student.js/discover.js.
if (document.getElementById("admin-stats")) {
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      window.location.replace("admin-login.html");
      return;
    }
    if (!isAdminEmail(user.email)) {
      window.location.replace("discover.html");
      return;
    }
    currentUser = user;
    document.body.classList.remove("auth-pending");
    initDashboard();
  });
}
// These four are safe to call unconditionally on every page — each one
// no-ops internally if its expected element isn't present (e.g. running on
// the dashboard instead of the login page).
initLoginForm();
initPasswordToggle();
initRoleTabs();
initForgotPassword();
