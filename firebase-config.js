import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBoAAY_fXVQJM1iCQnFgtwn6AMq9yE_Y7w",
  authDomain: "aic-273d7.firebaseapp.com",
  projectId: "aic-273d7",
  storageBucket: "aic-273d7.firebasestorage.app",
  messagingSenderId: "626233784498",
  appId: "1:626233784498:web:15cbe337f9d0ef4b8871ab",
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
