/* Smart Cup HQ: Firebase backend for the room.
   The room's page code was written for claude.ai's db / user / room capabilities; this module serves
   the same small API (doc/collection with get/set/update/delete/onSnapshot/orderBy/add, user.me/can/profiles,
   room.presence/onPeers, plus media for photos and videos) from Firestore, behind an email sign-in limited to the team. */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged, sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, GoogleAuthProvider, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection, getDoc as fsGetDoc, setDoc as fsSetDoc, updateDoc as fsUpdateDoc, deleteDoc as fsDeleteDoc, onSnapshot as fsOnSnapshot, query, orderBy, addDoc as fsAddDoc, increment, arrayUnion, Bytes } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDPCvwE-B5UcIwFauo4aQLWrBpxU8xm2NE",
  authDomain: "pulse-cup.firebaseapp.com",
  projectId: "pulse-cup",
  storageBucket: "pulse-cup.firebasestorage.app",
  messagingSenderId: "960228406991",
  appId: "1:960228406991:web:83d7102a429a3e1e41a9ba"
};
/* Who may enter. The same list is enforced server-side by the Firestore rules (see firestore.rules). */
const TEAM = ["cgrcasanova@gmail.com", "pjc.casanova@gmail.com", "idavidsrno96@gmail.com", "verdes.eu.genio@gmail.com", "gonvipa@gmail.com", "schwarzpower13@gmail.com"];
const ADMIN = "schwarzpower13@gmail.com";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
let fs;
try { fs = initializeFirestore(app, {ignoreUndefinedProperties:true, localCache:persistentLocalCache({tabManager:persistentMultipleTabManager()})}); }
catch (e){ fs = initializeFirestore(app, {ignoreUndefinedProperties:true}); }

const $ = id => document.getElementById(id);
const gate = $("hq-gate"), msg = $("hq-g-msg");
const say = (t, err) => { msg.textContent = t || ""; msg.classList.toggle("err", !!err); };
const LSK = "hq:email";
const lsGet = k => { try { return localStorage.getItem(k); } catch (e){ return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e){} };
const allowed = email => TEAM.includes(String(email || "").toLowerCase());

/* ---------- free-plan meter ----------
   The free plan allows 50k reads, 20k writes and 20k deletes a day (the day ends at midnight in California,
   08:00 in Lisbon). Every read and write this device makes is counted here and saved with the activity,
   so the admin sees the whole team's total. It counts on the safe side: every app open as a full re-read. */
const U = {r:0, w:0, d:0};
let quotaAt = 0;
const PDAY = new Intl.DateTimeFormat("en-CA", {timeZone:"America/Los_Angeles", year:"numeric", month:"2-digit", day:"2-digit"});
const PCLOCK = new Intl.DateTimeFormat("en-US", {timeZone:"America/Los_Angeles", hour12:false, hour:"2-digit", minute:"2-digit", second:"2-digit"});
const pday = (t) => PDAY.format(t || new Date());
let resetMemo = 0;
function noteQuota(e){ if (e && (e.code === "resource-exhausted" || /quota/i.test(e.message || ""))){ quotaAt = Date.now(); try { window.dispatchEvent(new CustomEvent("hq-quota")); } catch (x){} } }
const counted = (k, pr) => { U[k]++; return pr.catch(e => { noteQuota(e); throw e; }); };
const getDoc = r => counted("r", fsGetDoc(r));
const setDoc = (r, d, o) => counted("w", o ? fsSetDoc(r, d, o) : fsSetDoc(r, d));
const updateDoc = (r, d) => counted("w", fsUpdateDoc(r, d));
const addDoc = (r, d) => counted("w", fsAddDoc(r, d));
const deleteDoc = r => counted("d", fsDeleteDoc(r));
function onSnapshot(ref, next, err){
  let first = true;
  return fsOnSnapshot(ref, s => {
    try {
      if (Array.isArray(s.docs)){ if (first) U.r += Math.max(1, s.size || 0); else U.r += typeof s.docChanges === "function" ? s.docChanges().length : 0; }
      else U.r += 1;
      first = false;
    } catch (x){}
    next(s);
  }, e => { noteQuota(e); if (err) err(e); });
}

/* ---------- error mapping to the codes the room understands ---------- */
function mapErr(e){
  const c = e && e.code || "";
  noteQuota(e);
  if (c === "permission-denied") return {code:"invalid_argument", message:e.message};
  if (c === "resource-exhausted") return {code:"resource_exhausted", message:e.message};
  if (c === "unauthenticated") return {code:"revoked", message:e.message};
  return {code:"unavailable", message:(e && e.message) || String(e)};
}
const fail = e => { throw mapErr(e); };
const snapDoc = s => { const ok = s.exists(); const d = ok ? s.data() : undefined; return {id:s.id, exists:ok, data:() => d, metadata:{fromCache:s.metadata.fromCache, hasPendingWrites:s.metadata.hasPendingWrites}}; };

/* ---------- db ---------- */
function mkDoc(path){
  const ref = doc(fs, path);
  return {
    id:ref.id, path,
    get: () => getDoc(ref).then(snapDoc, fail),
    set: d => setDoc(ref, d).catch(fail),
    update: d => updateDoc(ref, d).catch(fail),
    delete: () => deleteDoc(ref).catch(fail),
    onSnapshot: (next, err) => onSnapshot(ref, s => next(snapDoc(s)), e => err && err(mapErr(e))),
    collection: sub => mkCol(path + "/" + sub)
  };
}
function mkCol(path, order){
  const ref = collection(fs, path);
  const q = order ? query(ref, orderBy(order[0], order[1] || "asc")) : ref;
  return {
    path,
    doc: id => mkDoc(path + "/" + (id || Math.random().toString(36).slice(2) + Date.now().toString(36))),
    add: d => addDoc(ref, d).then(r => mkDoc(r.path), fail),
    orderBy: (field, dir) => mkCol(path, [field, dir]),
    onSnapshot: (next, err) => onSnapshot(q, s => next({docs:s.docs.map(snapDoc), size:s.size, empty:s.empty, docChanges:() => [], metadata:{fromCache:s.metadata.fromCache, hasPendingWrites:s.metadata.hasPendingWrites}}), e => err && err(mapErr(e)))
  };
}
const db = {doc:mkDoc, collection:mkCol};

/* ---------- media: photos and videos, kept in Firestore in <1 MB chunks (no paid Storage needed) ----------
   New uploads are stored as raw bytes (older ones as base64 text, still readable). Every file is saved on the
   device after its first download, so it is fetched from Firebase once per device, not on every visit.
   The free plan holds 1 GB in total, so uploads stop at a team budget and the text always keeps room. */
const CHUNK = 720000, CHUNK_B = 1000000, VIDEO_MAX = 30 * 1024 * 1024;
const BUDGET = 850 * 1024 * 1024, PHOTO_BUDGET = 950 * 1024 * 1024;
const mediaCache = new Map();
const DEV = "hq-media-v1", devKey = id => new URL("__media/" + id, location.href).href;
async function devGet(id){ try { if (!("caches" in window)) return null; const r = await (await caches.open(DEV)).match(devKey(id)); return r ? await r.blob() : null; } catch (e){ return null; } }
async function devPut(id, blob){ try { if ("caches" in window) await (await caches.open(DEV)).put(devKey(id), new Response(blob, {headers:{"content-type":blob.type || "application/octet-stream"}})); } catch (e){} }
async function devDel(id){ try { if ("caches" in window) await (await caches.open(DEV)).delete(devKey(id)); } catch (e){} }
/* what the team's photos and videos take in the database (base64 text is a third bigger than the file) */
const storedSize = m => (m.enc === "b" ? (m.size || 0) : Math.ceil((m.size || 0) * 4 / 3)) + (m.poster ? m.poster.length : 0) + 400;
let usageMemo = null;
function readUsage(){
  return new Promise((res, rej) => { let u = null, done = false; u = onSnapshot(collection(fs, "media"), s => {
    if (done) return; done = true; setTimeout(() => u && u(), 0);
    const r = {bytes:0, photos:0, videos:0, photoBytes:0, videoBytes:0, budget:BUDGET, total:1024 * 1024 * 1024};
    s.docs.forEach(d => { const m = d.data() || {}; const b = storedSize(m); r.bytes += b; if (m.kind === "video"){ r.videos++; r.videoBytes += b; } else { r.photos++; r.photoBytes += b; } });
    res(r);
  }, e => rej(mapErr(e))); });
}
function b64(u8){ let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s){ const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
async function shrinkImage(file){
  try {
    const bmp = await createImageBitmap(file, {imageOrientation:"from-image"});
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height)), w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
    const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", .84));
    if (blob) return {blob, type:"image/jpeg", w, h};
  } catch (e){}
  if (file.size > 4 * 1024 * 1024) throw {code:"unsupported", message:"This photo format can't be read here. Try a JPG or PNG."};
  return {blob:file, type:file.type || "image/jpeg", w:0, h:0};
}
function videoPoster(file){
  return new Promise(res => {
    const v = document.createElement("video"), url = URL.createObjectURL(file); let done = false;
    const fin = x => { if (done) return; done = true; URL.revokeObjectURL(url); res(x); };
    setTimeout(() => fin({poster:null, w:0, h:0}), 5000);
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
    v.addEventListener("loadeddata", () => { try { v.currentTime = Math.min(.5, (v.duration || 1) / 3); } catch (e){ fin({poster:null, w:0, h:0}); } }, {once:true});
    v.addEventListener("seeked", () => {
      try {
        const k = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight)), w = Math.round(v.videoWidth * k), h = Math.round(v.videoHeight * k);
        const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(v, 0, 0, w, h);
        fin({poster:c.toDataURL("image/jpeg", .7), w:v.videoWidth, h:v.videoHeight, dur:v.duration || 0});
      } catch (e){ fin({poster:null, w:0, h:0}); }
    }, {once:true});
    v.addEventListener("error", () => fin({poster:null, w:0, h:0}), {once:true});
  });
}
function mkMedia(uid){
  return {
    maxVideo: VIDEO_MAX,
    async put(file, onProgress){
      const isV = /^video\//.test(file.type);
      if (!isV && !/^image\//.test(file.type)) throw {code:"unsupported", message:"Only photos and videos."};
      if (isV && file.size > VIDEO_MAX) throw {code:"too_big", message:"Videos can be up to 30 MB. Trim it, record at 720p, or share a Google Drive / YouTube link."};
      const p = isV ? {blob:file, type:file.type || "video/mp4", ...(await videoPoster(file))} : await shrinkImage(file);
      const u8 = new Uint8Array(await p.blob.arrayBuffer()), n = Math.max(1, Math.ceil(u8.length / CHUNK_B));
      /* keep the free 1 GB from filling up: past the budget, videos stop first, then photos; text is never blocked */
      try {
        if (!usageMemo || Date.now() - usageMemo.at > 5 * 60e3) usageMemo = {at:Date.now(), u:await readUsage()};
        const after = usageMemo.u.bytes + u8.length;
        if (after > (isV ? BUDGET : PHOTO_BUDGET)) throw {code:"too_big", message:isV ? "The team's video space is full. Share this video as a Google Drive or YouTube link instead." : "The team's photo space is full. Delete old uploads you don't need, or share a link instead."};
      } catch (e){ if (e && e.code === "too_big") throw e; }
      const id = "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      let sent = 0, next = 0;
      const work = async () => { while (next < n){ const i = next++; await setDoc(doc(fs, "media", id, "c", String(i)), {b:Bytes.fromUint8Array(u8.slice(i * CHUNK_B, (i + 1) * CHUNK_B))}); sent++; if (onProgress) onProgress(sent / n); } };
      try { await Promise.all([work(), work(), work()]); } catch (e){ throw mapErr(e); }
      const meta = {kind:isV ? "video" : "image", type:p.type, name:String(file.name || "").slice(0, 120), size:u8.length, n, enc:"b", w:p.w || 0, h:p.h || 0, poster:p.poster || null, dur:p.dur || 0, at:Date.now(), by:uid};
      await setDoc(doc(fs, "media", id), meta).catch(fail);
      if (usageMemo) usageMemo.u.bytes += storedSize(meta);
      const blob = new Blob([u8], {type:p.type}); devPut(id, blob);
      mediaCache.set(id, Promise.resolve(URL.createObjectURL(blob)));
      return {id, kind:meta.kind, w:meta.w, h:meta.h, poster:meta.poster, name:meta.name};
    },
    url(id){
      if (!mediaCache.has(id)){
        const pr = (async () => {
          const kept = await devGet(id); if (kept) return URL.createObjectURL(kept);
          const m = await getDoc(doc(fs, "media", id)); if (!m.exists()) throw {code:"not_found"};
          const meta = m.data();
          const parts = await Promise.all(Array.from({length:meta.n}, (_, i) => getDoc(doc(fs, "media", id, "c", String(i))).then(s => { const x = s.data(); return x.b ? x.b.toUint8Array() : unb64(x.d); })));
          const blob = new Blob(parts, {type:meta.type}); devPut(id, blob);
          return URL.createObjectURL(blob);
        })();
        pr.catch(() => mediaCache.delete(id));
        mediaCache.set(id, pr);
      }
      return mediaCache.get(id);
    },
    async del(id){
      try { const m = await getDoc(doc(fs, "media", id)); const n = m.exists() ? m.data().n : 0; for (let i = 0; i < n; i++) await deleteDoc(doc(fs, "media", id, "c", String(i))); await deleteDoc(doc(fs, "media", id)); devDel(id); usageMemo = null; } catch (e){}
    },
    usage: () => readUsage()
  };
}

/* ---------- activity: each person adds their own time and actions per day; only the admin can read it ---------- */
function mkActivity(uid){
  const day = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  return {
    bump(x){
      const inc = o => { const r = {}; for (const k in o) if (o[k]) r[k] = increment(o[k]); return r; };
      const d = {uid, day:day(), seat:x.seat || null, name:x.name || "", v:x.v || 0, last:Date.now()};
      if (x.ms) d.ms = increment(x.ms);
      if (x.views && Object.keys(x.views).length) d.views = inc(x.views);
      if (x.acts && Object.keys(x.acts).length) d.acts = inc(x.acts);
      if (x.log && x.log.length) d.log = arrayUnion(...x.log);
      if (x.start) d.starts = arrayUnion(x.start);
      const q = {r:U.r, w:U.w, d:U.d}, pd = pday(); U.r = 0; U.w = 0; U.d = 0;
      if (q.r) d.qr = {[pd]:increment(q.r)};
      if (q.w) d.qw = {[pd]:increment(q.w)};
      if (q.d) d.qd = {[pd]:increment(q.d)};
      return setDoc(doc(fs, "activity", uid + "_" + d.day), d, {merge:true}).catch(e => { U.r += q.r; U.w += q.w; U.d += q.d; fail(e); });
    },
    /* reads and writes not yet saved on this device */
    pending: () => U.r + U.w + U.d,
    quotaAt: () => quotaAt,
    /* when the free day ends, as a time on this device's clock */
    resetsAt(){ const now = new Date(); if (resetMemo > now.getTime()) return new Date(resetMemo); const p = PCLOCK.formatToParts(now); const g = t => +(p.find(x => x.type === t) || {}).value || 0; const gone = ((g("hour") % 24) * 3600 + g("minute") * 60 + g("second")) * 1000; resetMemo = now.getTime() + 864e5 - gone - now.getMilliseconds(); return new Date(resetMemo); },
    /* the whole team's use of today's free amounts (admin only; about a dozen reads) */
    async today(uids){
      const pd = pday(), d1 = new Date(pd + "T12:00:00"), d2 = new Date(d1.getTime() + 864e5);
      const ds = [d1, d2].map(x => x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0"));
      const out = {r:U.r, w:U.w, d:U.d, day:pd, people:0};
      const snaps = await Promise.all([...new Set(uids || [])].flatMap(u => ds.map(dd => getDoc(doc(fs, "activity", u + "_" + dd)).catch(() => null))));
      const seen = new Set();
      for (const sn of snaps){ if (!sn || !sn.exists()) continue; const x = sn.data() || {}; const r = (x.qr || {})[pd] || 0, w = (x.qw || {})[pd] || 0, dl = (x.qd || {})[pd] || 0; out.r += r; out.w += w; out.d += dl; if (r || w) seen.add(x.uid); }
      out.people = seen.size;
      return out;
    },
    all(){
      return new Promise((res, rej) => { let u = null, done = false; u = onSnapshot(collection(fs, "activity"), s => { if (done) return; done = true; res(s.docs.map(x => x.data())); setTimeout(() => u && u(), 0); }, e => rej(mapErr(e))); });
    }
  };
}

/* ---------- people (names for the admin's "who sits here") ---------- */
const people = {};
function watchPeople(){ onSnapshot(collection(fs, "people"), s => { s.docs.forEach(d => { people[d.id] = d.data(); }); }, () => {}); }

/* ---------- room: presence through presence/{uid} with a heartbeat ----------
   One beat every two minutes (and one when the app is hidden or shown) keeps six people online all day
   well inside the free 50k reads/day; a hidden app counts as away at once. */
function mkRoom(uid){
  let mine = {}, pushT = 0, last = [], cbs = [];
  const push = () => setDoc(doc(fs, "presence", uid), {p:mine, at:Date.now(), by:uid, away:document.visibilityState === "hidden"}).catch(() => {});
  const soon = () => { clearTimeout(pushT); pushT = setTimeout(push, 250); };
  setInterval(() => { if (document.visibilityState === "visible") push(); }, 120000);
  document.addEventListener("visibilitychange", () => push());
  window.addEventListener("pagehide", () => { setDoc(doc(fs, "presence", uid), {p:mine, at:0, by:uid}).catch(() => {}); });
  const emit = () => {
    const now = Date.now();
    const peers = last.filter(x => x && !x.away && now - (x.at || 0) < 270000).map(x => ({kind:"viewer", presence:x.p || {}, by:x.by, isMe:x.by === uid, guest:false}));
    cbs.forEach(fn => { try { fn({peers}); } catch (e){} });
  };
  onSnapshot(collection(fs, "presence"), s => { last = s.docs.map(d => d.data()); emit(); }, () => {});
  setInterval(emit, 45000);
  push();
  return {
    presence: patch => { mine = Object.assign({}, mine, patch || {}); soon(); return Promise.resolve(); },
    onPeers: (fn) => { cbs.push(fn); emit(); return () => { cbs = cbs.filter(x => x !== fn); }; },
    emit: () => Promise.resolve(), on: () => () => {}
  };
}

/* ---------- import from the old claude.ai room (admin, one time) ---------- */
document.addEventListener("change", async e => {
  if (!e.target || e.target.id !== "hq-import") return;
  const f = e.target.files && e.target.files[0]; if (!f) return;
  const out = document.createElement("p"); out.className = "mono"; out.style.marginTop = "8px"; e.target.after(out);
  try {
    const j = JSON.parse(await f.text());
    const cols = j && j.collections; if (!cols) throw new Error("This isn't an HQ export.");
    let n = 0;
    for (const [c, docs] of Object.entries(cols)){
      for (const [id, d] of Object.entries(docs || {})){ await setDoc(doc(fs, c, id), d); n++; out.textContent = "Importing… " + n; }
    }
    out.textContent = "Imported " + n + " items. Done.";
  } catch (err){ out.textContent = "Import failed: " + (err.message || err); }
});

/* ---------- sign in ---------- */
function showGate(sub){ gate.hidden = false; if (sub) $("hq-g-sub").textContent = sub; }
$("hq-g-form").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("hq-g-email").value.trim().toLowerCase();
  if (!allowed(email)){ say("This email isn't on the Smart Cup team. Use the email the admin added, or ask the admin.", true); return; }
  $("hq-g-send").disabled = true; say("Sending…");
  try {
    await sendSignInLinkToEmail(auth, email, {url:location.origin + location.pathname, handleCodeInApp:true});
    lsSet(LSK, email);
    say("Link sent to " + email + ". Open it on this computer or phone (check Spam too).");
  } catch (err){ say(authMsg(err), true); }
  finally { $("hq-g-send").disabled = false; }
});
$("hq-g-google").addEventListener("click", async () => {
  say("");
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (err){ if (err && err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") say(authMsg(err), true); }
});
function authMsg(err){
  const c = err && err.code || "";
  if (c === "auth/operation-not-allowed") return "This sign-in method isn't switched on in Firebase yet. Ask the admin.";
  if (c === "auth/unauthorized-domain" || c === "auth/unauthorized-continue-uri") return "This address isn't allowed in Firebase yet. Ask the admin to add it under Authorized domains.";
  if (c === "auth/invalid-action-code" || c === "auth/expired-action-code") return "That link has expired or was already used. Send a new one.";
  if (c === "auth/network-request-failed") return "No internet connection.";
  if (c === "auth/quota-exceeded" || c === "auth/too-many-requests") return "Today's sign-in emails are used up (the free plan sends 5 a day). Tap Continue with Google instead.";
  if (c === "auth/popup-blocked") return "The browser blocked the Google window. Allow pop-ups, or use the email link.";
  return "Couldn't sign in (" + (c || err && err.message || "error") + ").";
}
async function finishEmailLink(){
  if (!isSignInWithEmailLink(auth, location.href)) return;
  let email = lsGet(LSK);
  if (!email){ showGate("Confirm your email to finish signing in."); $("hq-g-email").focus(); say("Type the email you asked the link for, then tap the button again.");
    const f = $("hq-g-form"), handler = async ev => { ev.preventDefault(); ev.stopImmediatePropagation(); const em = $("hq-g-email").value.trim().toLowerCase(); try { await signInWithEmailLink(auth, em, location.href); lsSet(LSK, null); history.replaceState(null, "", location.pathname); } catch (err){ say(authMsg(err), true); } };
    f.addEventListener("submit", handler, {capture:true, once:true}); return; }
  try { await signInWithEmailLink(auth, email, location.href); lsSet(LSK, null); }
  catch (err){ showGate(); say(authMsg(err), true); }
  history.replaceState(null, "", location.pathname);
}

let started = false;
onAuthStateChanged(auth, async user => {
  if (!user){ if (!isSignInWithEmailLink(auth, location.href)) showGate(); return; }
  const email = String(user.email || "").toLowerCase();
  if (!allowed(email)){ await signOut(auth); showGate(); say(email + " isn't on the Smart Cup team.", true); return; }
  gate.hidden = true;
  if (started) return; started = true;
  const uid = user.uid;
  const name = user.displayName || email.split("@")[0];
  setDoc(doc(fs, "people", uid), {name, email, at:Date.now()}).catch(() => {});
  watchPeople();
  const userApi = {
    me: async () => ({id:uid, name, email, isOwner:email === ADMIN, guest:false}),
    id: async () => uid,
    isOwner: async () => email === ADMIN,
    canEdit: async () => email === ADMIN,
    can: async () => true,
    profiles: async ids => { const o = {}; (ids || []).forEach(id => { const p = people[id]; o[id] = {id, name:p ? (p.name || p.email || "") : "", isMe:id === uid, guest:false}; }); return o; },
    search: async () => []
  };
  window.__hqResolve({db, user:userApi, room:mkRoom(uid), media:mkMedia(uid), activity:mkActivity(uid)});
  const so = $("hq-signout"); if (so) so.addEventListener("click", async () => { await signOut(auth); location.reload(); });
});
finishEmailLink();

/* logo on the gate */
$("hq-g-mark").innerHTML = '<svg viewBox="0 0 64 64" width="96" height="96" aria-hidden="true" style="overflow:visible"><path d="M25 13 L22 9 M39 13 L42 9 M32 10 L32 5" stroke="#F0A83C" stroke-width="1.5" stroke-linecap="round" fill="none"/><g transform="translate(16 59) rotate(15)"><path d="M-10 -32 L10 -32 L7 -2 Q0 1 -7 -2 Z" fill="#1a1624" stroke="#F3EFE8" stroke-width="1.6" stroke-linejoin="round"/><ellipse cx="0" cy="-32" rx="10" ry="2.4" fill="#241f30" stroke="#F3EFE8" stroke-width="1.2"/><circle cx="0" cy="-17" r="4.3" fill="#F0A83C"/></g><g transform="translate(48 59) rotate(-15)"><path d="M-10 -32 L10 -32 L7 -2 Q0 1 -7 -2 Z" fill="#1a1624" stroke="#F3EFE8" stroke-width="1.6" stroke-linejoin="round"/><ellipse cx="0" cy="-32" rx="10" ry="2.4" fill="#241f30" stroke="#F3EFE8" stroke-width="1.2"/><circle cx="0" cy="-17" r="4.3" fill="#FF2FB9"/></g><g transform="translate(32 21)"><path d="M0 -7 C.6 -2 2 -.6 7 0 C2 .6 .6 2 0 7 C-.6 2 -2 .6 -7 0 C-2 -.6 -.6 -2 0 -7Z" fill="#F0A83C"/></g></svg>';

/* install as an app */
let deferred = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferred = e; $("hq-install").hidden = false; });
$("hq-install").addEventListener("click", async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice.catch(() => {}); deferred = null; $("hq-install").hidden = true; });
window.addEventListener("appinstalled", () => { $("hq-install").hidden = true; });
/* offline cache; a new version takes over on its own and the page reloads once so everyone is on the latest */
if ("serviceWorker" in navigator && location.protocol === "https:"){
  const had = !!navigator.serviceWorker.controller; let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (had && !reloaded){ reloaded = true; location.reload(); } });
  navigator.serviceWorker.register("sw.js", {updateViaCache:"none"}).then(reg => {
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
    setInterval(() => reg.update().catch(() => {}), 30 * 60e3);
  }).catch(() => {});
}
