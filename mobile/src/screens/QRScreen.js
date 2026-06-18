import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { COLORS, API_BASE, TIER_LABEL } from '../theme';

export default function QRScreen() {
  const { token, member } = useAuth();
  const [qrData, setQrData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [countdown, setCountdown] = useState(300);
  const timerRef = useRef(null);
  const refreshRef = useRef(null);

  useEffect(() => {
    loadQR();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (refreshRef.current) clearTimeout(refreshRef.current);
    };
  }, []);

  async function loadQR() {
    setLoading(true);
    try {
      const res = await axios.get(`${API_BASE}/api/qr-generate`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setQrData(res.data);
      const secLeft = Math.floor(res.data.refreshInMs / 1000);
      setCountdown(secLeft);
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        setCountdown(c => {
          if (c <= 1) { clearInterval(timerRef.current); loadQR(); return 0; }
          return c - 1;
        });
      }, 1000);
    } catch (_) {}
    setLoading(false);
  }

  const mins = Math.floor(countdown / 60);
  const secs = countdown % 60;

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <Text style={s.logo}>ZOLA</Text>
        <Text style={s.headerTitle}>My Member QR</Text>
      </View>
      <View style={s.content}>
        {loading ? (
          <ActivityIndicator size="large" color={COLORS.champagne} style={{ marginTop: 60 }} />
        ) : qrData ? (
          <>
            <Text style={s.sub}>Show this at the studio to check in. It refreshes automatically.</Text>
            <View style={s.qrCard}>
              <QRCode
                value={qrData.qrPayload}
                size={220}
                color={COLORS.espresso}
                backgroundColor="#ffffff"
              />
              <Text style={s.watermark}>{qrData.fullName} · {qrData.memberId}</Text>
            </View>
            <Text style={s.memberId}>{qrData.memberId}</Text>
            <View style={[s.tierPill]}>
              <Text style={s.tierText}>{TIER_LABEL[qrData.tier] || qrData.tier}</Text>
            </View>
            <Text style={s.countdown}>Refreshes in {mins}:{String(secs).padStart(2, '0')}</Text>
            <Text style={s.warning}>Do not screenshot — screenshots will not be accepted at the studio.</Text>
            <TouchableOpacity style={s.refreshBtn} onPress={loadQR}>
              <Text style={s.refreshBtnText}>REFRESH NOW</Text>
            </TouchableOpacity>
          </>
        ) : (
          <Text style={s.errorText}>Could not load QR. Check your connection.</Text>
        )}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.softWhite },
  header: { backgroundColor: COLORS.espresso, padding: 20 },
  logo: { fontSize: 16, color: COLORS.champagne, letterSpacing: 4, fontWeight: '300', marginBottom: 4 },
  headerTitle: { fontSize: 22, color: COLORS.cream, fontWeight: '300' },
  content: { flex: 1, alignItems: 'center', padding: 24 },
  sub: { fontSize: 12, color: COLORS.latte, textAlign: 'center', lineHeight: 18, marginBottom: 20 },
  qrCard: { backgroundColor: '#fff', padding: 20, borderWidth: 1, borderColor: 'rgba(201,165,90,0.2)', alignItems: 'center', marginBottom: 16 },
  watermark: { fontSize: 10, color: COLORS.latte, marginTop: 10 },
  memberId: { fontSize: 24, color: COLORS.champagne, letterSpacing: 3, fontWeight: '300', marginBottom: 8 },
  tierPill: { backgroundColor: 'rgba(201,165,90,0.12)', paddingHorizontal: 12, paddingVertical: 4, marginBottom: 16 },
  tierText: { fontSize: 10, color: COLORS.champagne, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase' },
  countdown: { fontSize: 14, color: COLORS.latte, marginBottom: 8 },
  warning: { fontSize: 11, color: 'rgba(180,50,50,0.7)', textAlign: 'center', marginBottom: 20, lineHeight: 16, maxWidth: 280 },
  refreshBtn: { borderWidth: 1, borderColor: COLORS.champagne, paddingHorizontal: 20, paddingVertical: 10 },
  refreshBtnText: { fontSize: 11, color: COLORS.champagne, fontWeight: '700', letterSpacing: 2 },
  errorText: { fontSize: 14, color: COLORS.latte, marginTop: 60 },
});
