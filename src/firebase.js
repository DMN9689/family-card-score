import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyD9eKTT3il_1pgKIHM67gstB4adNt8ywuo",
  authDomain: "family-card-score.firebaseapp.com",
  projectId: "family-card-score",
  storageBucket: "family-card-score.firebasestorage.app",
  messagingSenderId: "734980309612",
  appId: "1:734980309612:web:f8bfe8bf1b1f5c94048e49",
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);