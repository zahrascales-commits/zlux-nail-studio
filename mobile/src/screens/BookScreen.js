import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { COLORS, TIER_LABEL, API_BASE } from '../theme';

export default function BookScreen() {
  const { token, member } = useAuth();
  const [windowData, setWindowData] = useState(null);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    loadWindow();
  }, []);

  useEffect(() => {
    if (countdown > 0) {
      const t = setTimeout(() => setCountdown(c => Math.max(0, c - 1000)), 1000);
      return () => clearTimeout(t);
    }
  }, [countdown]);

  async function loadWindow() {
    try {
      const res = await axios.get(`${API_BASE}/api/booking-windows`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setWindowData(res.data);
      if (res.data.countdownMs > 0) setCountdown(res.data.countdownMs);
    } catch (_) {}
  }

  const h = Math.floor(countdown / 3600000);
  const m = Math.floor((countdown % 3600000) / 60000);
  const s = Math.floor((countdown % 60000) / 1000);
  const countdownStr = h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;

  return (
    <SafeAreaView style={ss.safe}>
      <View style={ss.header}>
        <Text style={ss.logo}>ZOLA</Text>
        <Text style={ss.title}>Book an Appointment</Text>
      </View>
      <View style={ss.content}>
        <View style={ss.card}>
          <Text style={ss.cardTitle}>YOUR BOOKING ACCESS</Text>
          <Text style={ss.tierLine}>{TIER_LABEL[member?.tier] || '—'}</Text>
          {windowData && (
            <Text style={ss.daysLine}>You can book <Text style={ss.daysNum}>{windowData.daysAhead}</Text> day{windowData.daysAhead !== 1 ? 's' : ''} in advance</Text>
          )}
          {countdown > 0 && (
            <View style={ss.countdownBox}>
              <Text style={ss.countdownLabel}>YOUR WINDOW OPENS IN</Text>
              <Text style={ss.countdownClock}>{countdownStr}</Text>
            </View>
          )}
        </View>

        <View style={ss.card}>
          <Text style={ss.cardTitle}>BOOKING PRIORITY</Text>
          <View style={ss.priorityRow}><Text style={ss.priorityTier}>Black Card</Text><Text style={ss.priorityVal}>20 days ahead</Text></View>
          <View style={ss.priorityRow}><Text style={ss.priorityTier}>Luxe Club</Text><Text style={ss.priorityVal}>13 days ahead</Text></View>
          <View style={ss.priorityRow}><Text style={ss.priorityTier}>Signature</Text><Text style={ss.priorityVal}>3 days ahead</Text></View>
          <View style={[ss.priorityRow, { borderBottomWidth: 0 }]}><Text style={ss.priorityTier}>Public</Text><Text style={ss.priorityVal}>Same day</Text></View>
        </View>

        <TouchableOpacity style={ss.bookBtn} onPress={() => Linking.openURL(`${API_BASE}/booking.html`)}>
          <Text style={ss.bookBtnText}>OPEN BOOKING CALENDAR</Text>
        </TouchableOpacity>

        {member?.tier !== 'BLACK_CARD' && (
          <TouchableOpacity style={ss.upgradeBtn} onPress={() => Linking.openURL(`${API_BASE}/memberships.html`)}>
            <Text style={ss.upgradeBtnText}>Upgrade for earlier access →</Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

const ss = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.softWhite },
  header: { backgroundColor: COLORS.espresso, padding: 20 },
  logo: { fontSize: 16, color: COLORS.champagne, letterSpacing: 4, fontWeight: '300', marginBottom: 4 },
  title: { fontSize: 22, color: COLORS.cream, fontWeight: '300' },
  content: { flex: 1, padding: 16 },
  card: { backgroundColor: '#fff', padding: 18, borderWidth: 1, borderColor: 'rgba(201,165,90,0.12)', marginBottom: 12 },
  cardTitle: { fontSize: 10, fontWeight: '700', letterSpacing: 2, color: COLORS.latte, textTransform: 'uppercase', marginBottom: 12 },
  tierLine: { fontSize: 22, color: COLORS.espresso, fontWeight: '300', marginBottom: 6 },
  daysLine: { fontSize: 14, color: COLORS.latte, lineHeight: 20 },
  daysNum: { color: COLORS.champagne, fontWeight: '600' },
  countdownBox: { backgroundColor: 'rgba(201,165,90,0.07)', padding: 14, marginTop: 14, alignItems: 'center' },
  countdownLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 2, color: COLORS.latte, textTransform: 'uppercase', marginBottom: 4 },
  countdownClock: { fontSize: 32, color: COLORS.champagne, fontWeight: '300' },
  priorityRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(201,165,90,0.07)' },
  priorityTier: { fontSize: 14, color: COLORS.espresso },
  priorityVal: { fontSize: 13, color: COLORS.latte },
  bookBtn: { backgroundColor: COLORS.champagne, padding: 16, alignItems: 'center', marginBottom: 10 },
  bookBtnText: { color: COLORS.espresso, fontWeight: '700', fontSize: 12, letterSpacing: 2.5 },
  upgradeBtn: { alignItems: 'center', padding: 12 },
  upgradeBtnText: { fontSize: 13, color: COLORS.champagne },
});
