import {
  collection,
  addDoc,
  query,
  where,
  orderBy,
  getDocs,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { db, auth } from "./firebase-config.js";
import { isAdminEmail } from "./roles.js";

// Powers both student-dashboard.html (the "new request" form) and
// my-requests.html (a student's own request history + calendar). Which one
// runs is decided by which page's root element is present — see the two
// onAuthStateChanged gates at the bottom of this file.
const BOOKINGS_COLLECTION = "bookings";

let currentUser = null;

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

// Comment thread on a single booking (staff <-> organizer), collapsed by
// default. Comments only fetch the first time the thread is expanded, not
// up front for every card — avoids firing one Firestore query per booking
// just to render a list of cards. Same pattern duplicated in admin.js
// (styled differently there for the light-themed dashboard).
function buildCommentsSection(bookingId) {
  const wrap = document.createElement("div");
  wrap.className = "admin-comments";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "admin-comments-toggle";
  toggle.textContent = "comments";
  wrap.appendChild(toggle);

  const panel = document.createElement("div");
  panel.className = "admin-comments-panel";
  panel.hidden = true;
  wrap.appendChild(panel);

  const list = document.createElement("div");
  list.className = "admin-comments-list";
  panel.appendChild(list);

  const form = document.createElement("form");
  form.className = "admin-comments-form";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "write a comment…";
  input.required = true;
  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.textContent = "send";
  form.append(input, submitBtn);
  panel.appendChild(form);

  function renderComments(comments) {
    list.innerHTML = "";
    if (comments.length === 0) {
      const empty = document.createElement("p");
      empty.className = "admin-comments-empty";
      empty.textContent = "no comments yet.";
      list.appendChild(empty);
      return;
    }
    comments.forEach((comment) => {
      const item = document.createElement("div");
      item.className = "admin-comment";
      const meta = document.createElement("p");
      meta.className = "admin-comment-meta";
      meta.innerHTML = `<strong>${comment.authorEmail}</strong> · ${formatCommentTime(comment.createdAt)}`;
      const text = document.createElement("p");
      text.className = "admin-comment-text";
      text.textContent = comment.text;
      item.append(meta, text);
      list.appendChild(item);
    });
    list.scrollTop = list.scrollHeight;
  }

  let loaded = false;
  async function loadComments() {
    list.innerHTML = `<p class="admin-comments-empty">loading…</p>`;
    try {
      renderComments(await fetchComments(bookingId));
      loaded = true;
    } catch (err) {
      list.innerHTML = `<p class="admin-comments-empty">couldn't load comments: ${err.message}</p>`;
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
      window.alert(`couldn't post that comment: ${err.message}`);
    } finally {
      submitBtn.disabled = false;
    }
  });

  return wrap;
}

// Not a real secret — this file ships to the browser, so anyone can read it from
// page source. It only deters casual/scripted abuse of the email endpoint, same
// tier of protection as the Firebase client config above. Must match the
// APP_SHARED_SECRET env var set on the Vercel project.
const APP_SHARED_SECRET = "dbyajSLW9f-Y0gUdR1j4rDJObbv7x8KN";

// Posts to the /api/send-email serverless function (see api/send-email.js).
// Deliberately never throws — a failed notification email shouldn't undo or
// block a booking that already saved successfully to Firestore.
async function sendEmail(type, booking, link) {
  try {
    const res = await fetch("/api/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-app-secret": APP_SHARED_SECRET },
      body: JSON.stringify({ type, booking, link }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (err) {
    console.warn(`Booking was saved, but the "${type}" email failed to send:`, err.message);
  }
}

const STATUS_LABEL = {
  pending: "pending",
  approved: "approved",
  rejected: "rejected",
  published: "published",
};

function formatRange(startIso, dueIso) {
  const start = new Date(startIso);
  const due = new Date(dueIso);
  const startStr = start.toLocaleString("en-US", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const dueStr = due.toLocaleString("en-US", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  return `${startStr} → ${dueStr}`;
}

function buildCard(request) {
  const card = document.createElement("article");
  card.className = `admin-card card-${request.status}`;

  const body = document.createElement("div");

  const titleRow = document.createElement("div");
  titleRow.className = "admin-card-title-row";
  titleRow.innerHTML = `
    <h3 class="admin-card-title">${request.title}</h3>
    <span class="status-badge ${request.status}">${STATUS_LABEL[request.status]}</span>
  `;

  const when = document.createElement("p");
  when.className = "admin-card-meta";
  when.innerHTML = `<strong>window:</strong> ${formatRange(request.start, request.due)}`;

  const where = document.createElement("p");
  where.className = "admin-card-meta";
  where.innerHTML = `<strong>location:</strong> ${request.location} · <strong>platform:</strong> ${request.platform}`;

  const objective = document.createElement("p");
  objective.className = "admin-card-objective";
  objective.textContent = request.objective;

  body.append(titleRow, when, where, objective, buildCommentsSection(request.id));
  card.append(body);

  if (request.status === "published") {
    const actions = document.createElement("div");
    actions.className = "admin-card-actions";
    const link = document.createElement("a");
    link.className = "publish";
    link.href = `event.html?id=${encodeURIComponent(request.id)}`;
    link.textContent = "view event";
    actions.appendChild(link);
    card.appendChild(actions);
  }

  return card;
}

function dateKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDayTime(iso) {
  return new Date(iso)
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    .replace(" ", "")
    .toLowerCase();
}

// Renders one month of a plain CSS-grid calendar (my-requests.html). Days
// with requests get up to 2 title chips inline plus a "+N more" overflow
// label; clicking a day toggles it as the active filter for the request
// list below (handled by initCalendar's onSelectDay closure).
function buildCalendarGrid(container, year, month, requestsByDay, selectedKey, onSelectDay) {
  container.innerHTML = "";
  const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  WEEKDAYS.forEach((label) => {
    const el = document.createElement("div");
    el.className = "cal-weekday";
    el.textContent = label;
    container.appendChild(el);
  });

  const firstWeekday = new Date(year, month, 1).getDay();
  const totalDays = new Date(year, month + 1, 0).getDate();
  const todayKey = dateKey(new Date());

  for (let i = 0; i < firstWeekday; i += 1) {
    const filler = document.createElement("div");
    filler.className = "cal-day empty";
    container.appendChild(filler);
  }

  for (let day = 1; day <= totalDays; day += 1) {
    const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const dayRequests = requestsByDay.get(key) || [];

    const cell = document.createElement("div");
    cell.className = "cal-day";
    if (dayRequests.length) cell.classList.add("has-events");
    if (key === selectedKey) cell.classList.add("selected");
    if (key === todayKey) cell.classList.add("today");

    const num = document.createElement("span");
    num.className = "cal-day-num";
    num.textContent = String(day);
    cell.appendChild(num);

    dayRequests.slice(0, 2).forEach((request) => {
      const chip = document.createElement("span");
      chip.className = "cal-event-chip";
      const dot = document.createElement("span");
      dot.className = `cal-event-dot ${request.status}`;
      const text = document.createElement("span");
      text.className = "cal-event-text";
      text.textContent = `${formatDayTime(request.start)} ${request.title}`;
      chip.append(dot, text);
      cell.appendChild(chip);
    });

    if (dayRequests.length > 2) {
      const more = document.createElement("span");
      more.className = "cal-event-more";
      more.textContent = `+${dayRequests.length - 2} more`;
      cell.appendChild(more);
    }

    if (dayRequests.length) {
      cell.addEventListener("click", () => onSelectDay(key));
    }

    container.appendChild(cell);
  }
}

// Owns the calendar's month/selected-day state and re-renders the grid +
// notifies the caller (onFilterChange) of which requests should currently be
// visible — either everything, or just the selected day's requests, if one
// is picked. Clicking an already-selected day deselects it (see the
// toggle in buildCalendarGrid's onSelectDay callback below).
function initCalendar(getRequests, onFilterChange) {
  const grid = document.getElementById("request-calendar-grid");
  const label = document.getElementById("cal-month-label");
  const prevBtn = document.getElementById("cal-prev");
  const nextBtn = document.getElementById("cal-next");
  if (!grid || !label) return { refresh: () => {} };

  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth();
  let selectedKey = null;

  function refresh() {
    const requests = getRequests();
    const byDay = new Map();
    requests.forEach((request) => {
      const key = dateKey(request.start);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(request);
    });

    label.textContent = new Date(year, month, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    buildCalendarGrid(grid, year, month, byDay, selectedKey, (key) => {
      selectedKey = selectedKey === key ? null : key;
      refresh();
    });

    onFilterChange(selectedKey ? byDay.get(selectedKey) || [] : requests);
  }

  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      month -= 1;
      if (month < 0) {
        month = 11;
        year -= 1;
      }
      selectedKey = null;
      refresh();
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
      selectedKey = null;
      refresh();
    });
  }

  return { refresh };
}

async function fetchMyBookings(uid) {
  const q = query(collection(db, BOOKINGS_COLLECTION), where("createdByUid", "==", uid));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

function renderMyRequests(requests) {
  const list = document.getElementById("my-request-list");
  if (!list) return;

  list.innerHTML = "";

  if (requests.length === 0) {
    const empty = document.createElement("p");
    empty.className = "admin-list-empty";
    empty.textContent = "you haven't submitted any requests yet.";
    list.appendChild(empty);
    return;
  }

  const sorted = [...requests].sort((a, b) => new Date(b.start) - new Date(a.start));
  sorted.forEach((request) => list.appendChild(buildCard(request)));
}

function showApiError(message) {
  const list = document.getElementById("my-request-list");
  if (!list) return;
  list.innerHTML = "";
  const notice = document.createElement("p");
  notice.className = "admin-list-empty";
  notice.textContent = message;
  list.appendChild(notice);
}

function scrollToFormIfRequested() {
  const requestedView = new URLSearchParams(window.location.search).get("view");
  if (requestedView === "new") {
    document.getElementById("new-request-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

const DRAFT_KEY = "aic-livehub-request-draft";
const DRAFT_FIELDS = [
  "field-title",
  "field-organizer",
  "field-department",
  "field-location",
  "field-platform",
  "field-category",
  "field-audience",
  "field-stream-url",
  "field-objective",
];

// Manual "save draft" button (not autosave) that persists the new-request
// form's field values to localStorage, restored on next visit to this page.
// Cleared once a request is actually submitted (see initNewRequestForm).
// Browser-local only — doesn't sync across devices, unlike a real draft
// stored in Firestore would.
function initDraftSave() {
  const btn = document.getElementById("save-draft-btn");
  if (!btn) return;

  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    if (saved) {
      DRAFT_FIELDS.forEach((id) => {
        const el = document.getElementById(id);
        if (el && saved[id] !== undefined) el.value = saved[id];
      });
    }
  } catch (err) {
    console.warn("couldn't restore draft:", err);
  }

  btn.addEventListener("click", () => {
    const draft = {};
    DRAFT_FIELDS.forEach((id) => {
      const el = document.getElementById(id);
      if (el) draft[id] = el.value;
    });
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      const original = btn.textContent;
      btn.textContent = "Draft Saved ✓";
      setTimeout(() => {
        btn.textContent = original;
      }, 1500);
    } catch (err) {
      window.alert("couldn't save draft locally.");
    }
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

function initNewRequestForm(user, onCreated) {
  const form = document.getElementById("new-request-form");
  if (!form) return;

  const emailField = document.getElementById("field-organizer-email");
  if (emailField) emailField.value = user.email;

  const pickers = initDateTimePickers();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const booking = {
      title: document.getElementById("field-title").value.trim(),
      organizer: document.getElementById("field-organizer").value.trim(),
      organizerEmail: user.email,
      department: document.getElementById("field-department").value.trim(),
      location: document.getElementById("field-location").value.trim(),
      start: document.getElementById("field-start").value,
      due: document.getElementById("field-due").value,
      platform: document.getElementById("field-platform").value,
      category: document.getElementById("field-category").value,
      audience: document.getElementById("field-audience").value.trim(),
      objective: document.getElementById("field-objective").value.trim(),
      streamUrl: document.getElementById("field-stream-url").value.trim(),
      status: "pending",
      images: 0,
      createdByUid: user.uid,
    };

    if (!booking.start || !booking.due) {
      window.alert("pick a start and due date & time.");
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const docRef = await addDoc(collection(db, BOOKINGS_COLLECTION), booking);
      // Two separate emails fire on every submit: one notifies admins a
      // request needs review, the other confirms receipt to the organizer.
      // Both are fire-and-forget (sendEmail never throws) so a slow/failed
      // send can't block the redirect below.
      const dashboardLink = `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, "")}admin-dashboard.html`;
      const myRequestsLink = `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, "")}my-requests.html`;
      await Promise.all([
        sendEmail("admin_new_request", booking, dashboardLink),
        sendEmail("organizer_submitted", booking, myRequestsLink),
      ]);
      form.reset();
      pickers.start?.clear();
      pickers.due?.clear();
      if (emailField) emailField.value = user.email;
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch (err) {
        console.warn("couldn't clear saved draft:", err);
      }
      await onCreated({ id: docRef.id, ...booking });
    } catch (err) {
      window.alert(`couldn't submit that request: ${err.message}`);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
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

async function initStudentDashboard(user) {
  const nameEl = document.getElementById("profile-name");
  const avatarEl = document.getElementById("profile-avatar");
  if (nameEl) {
    nameEl.textContent = user.email;
    nameEl.title = user.email;
  }
  if (avatarEl) avatarEl.textContent = user.email.charAt(0).toUpperCase();

  initLogout();
  initAccountMenu();
  initMobileMenu();
  initDraftSave();
  scrollToFormIfRequested();

  initNewRequestForm(user, async () => {
    window.location.href = "my-requests.html";
  });
}

async function initMyRequestsPage(user) {
  const nameEl = document.getElementById("profile-name");
  const avatarEl = document.getElementById("profile-avatar");
  if (nameEl) {
    nameEl.textContent = user.email;
    nameEl.title = user.email;
  }
  if (avatarEl) avatarEl.textContent = user.email.charAt(0).toUpperCase();

  initLogout();
  initAccountMenu();
  initMobileMenu();

  let myRequests = [];

  const calendar = initCalendar(
    () => myRequests,
    (visible) => renderMyRequests(visible)
  );
  calendar.refresh();

  try {
    myRequests = await fetchMyBookings(user.uid);
    calendar.refresh();
  } catch (err) {
    showApiError(`can't reach Firestore — check your internet connection and Firebase config. (${err.message})`);
  }
}

// Two separate auth gates, one per page this file can run on — only the
// block matching the current page's root element actually does anything.
// Both redirect signed-out users to login and admins to their own
// dashboard, so this file only ever runs its logic for a signed-in student.
if (document.getElementById("new-request-form")) {
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
    initStudentDashboard(user);
  });
}

if (document.getElementById("my-request-list")) {
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      window.location.replace("admin-login.html");
      return;
    }
    if (isAdminEmail(user.email)) {
      window.location.replace("admin-dashboard.html");
      return;
    }
    currentUser = user;
    document.body.classList.remove("auth-pending");
    initMyRequestsPage(user);
  });
}
