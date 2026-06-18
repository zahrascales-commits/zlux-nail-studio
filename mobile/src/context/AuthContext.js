import React, { createContext, useContext, useState, useEffect } from 'react';
import * as SecureStore from 'expo-secure-store';
import axios from 'axios';
import { API_BASE } from '../theme';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [member, setMember] = useState(null);
  const [token, setToken] = useState(null);

  useEffect(() => {
    restoreSession();
  }, []);

  async function restoreSession() {
    try {
      const savedToken = await SecureStore.getItemAsync('zola_token');
      if (savedToken) {
        const res = await axios.get(`${API_BASE}/api/member-profile`, {
          headers: { Authorization: `Bearer ${savedToken}` },
        });
        if (res.data.member) {
          setToken(savedToken);
          setMember(res.data.member);
          setIsLoggedIn(true);
        }
      }
    } catch (_) {
      await SecureStore.deleteItemAsync('zola_token');
    } finally {
      setIsLoading(false);
    }
  }

  async function login(memberId, password) {
    const res = await axios.post(`${API_BASE}/api/member-login`, { memberId, password });
    const { token: t, member: m } = res.data;
    await SecureStore.setItemAsync('zola_token', t);
    setToken(t);
    setMember(m);
    setIsLoggedIn(true);
    return m;
  }

  async function logout() {
    await SecureStore.deleteItemAsync('zola_token');
    setToken(null);
    setMember(null);
    setIsLoggedIn(false);
  }

  async function refreshProfile() {
    if (!token) return;
    try {
      const res = await axios.get(`${API_BASE}/api/member-profile`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.data.member) setMember(res.data.member);
      return res.data;
    } catch (_) { return null; }
  }

  return (
    <AuthContext.Provider value={{ isLoggedIn, isLoading, member, token, login, logout, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() { return useContext(AuthContext); }
