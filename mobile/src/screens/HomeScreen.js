import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { COLORS, TIER_LABEL, TIER_MAX_SERVICES, API_BASE } from '../theme';

export default function HomeScreen({ navigation }) {
  const { member, token, refreshProfile } = useAuth();
  const [profile, setProfile] = useState(null);
  const [bookingWindow, setBookingWindow] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    try {
      const [p, bw] = await Promise.all([
        refreshProfile(),
        axios.get(`${API_BASE}/api/booking-windows`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      setProfile(p);
      setBookingWindow(bw.data);
    } catch (_) {}
  }

  async function onRefresh() {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }

  const usage = profile?.usage || {};
  const tierMax = TIER_MAX_SERVICES[member?.tier] || 1;
  const servicesLeft = Math.max(0, tierMax - (usage.services_used || 0));

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView style={s.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.champagne} />}>
        {/* Header */}
        <View style={s.header}>
          <Text style={s.headerLogo}>ZOLA</Text>
          <Text style={s.headerGreet}>Welcome back, {member?.fullName?.split(' ')[0] || '—'}</Text>
          <View style={s.tierPill}>
            <Text style={s.tierText}>{TIER_LABEL[member?.tier] || member?.tier}</Text>
          </View>
          <Text style={s.memberId}>{member?.memberId}</Text>
        </View>

        {/* Stats */}
        <View style={s.statsRow}>
          <View style={s.statBox}>
            <Text style={s.statNum}>{servicesLeft}</Text>
            <Text style={s.statLabel}>Services Left</Text>
          </View>
          <View style={s.statBox}>
            <Text style={s.statNum}>{profile?.upcoming?.length || 0}</Text>
            <Text style={s.statLabel}>Upcoming</Text>
          </View>
          <View style={s.statBox}>
            <Text style={s.statNum}>{bookingWindow?.daysAhead ?? '—'}</Text>
            <Text style={s.statLabel}>Days Ahead</Text>
          </View>
        </View>

        {/* Book CTA */}
        <TouchableOpacity style={s.bookBtn} onPress={() => Linking.openURL(`${API_BASE}/booking.html`)}>
          <Text style={s.bookBtnText}>BOOK AN APPOINTMENT</Text>
        </TouchableOpacity>

        {/* Upcoming appointments */}
        <View style={s.card}>
          <Text style={s.cardTitle}>UPCOMING APPOINTMENTS</Text>
          {profile?.upcoming?.length ? (
            profile.upcoming.map((a, i) => (
              <View key={i} style={s.apptRow}>
                <View>
                  <Text style={s.apptDate}>{new Date(a.appointment_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric' })}</Text>
                  <Text style={s.apptDetail}>{a.appointment_time} · {a.service}</Text>
                </View>
                <View style={[s.statusBadge, s['status_' + a.status]]}>
                  <Text style={s.statusText}>{a.status}</Text>
                </View>
              </View>
            ))
          ) : (
            <Text style={s.emptyText}>No upcoming appointments.</Text>
          )}
        </View>

        {/* Announcements */}
        {profile?.announcements?.length > 0 && (
          <View style={s.card}>
            <Text style={s.cardTitle}>STUDIO ANNOUNCEMENTS</Text>
            {profile.announcements.slice(0, 3).map((a, i) => (
              <View key={i} style={s.announceRow}>
                <Text style={s.announceSubject}>{a.subject || 'Studio Update'}</Text>
                <Text style={s.announceBody}>{a.body}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.softWhite },
  scroll: { flex: 1 },
  header: { backgroundColor: COLORS.espresso, padding: 24, paddingTop: 16 },
  headerLogo: { fontSize: 20, color: COLORS.champagne, letterSpacing: 5, fontWeight: '300', marginBottom: 8 },
  headerGreet: { fontSize: 22, color: COLORS.cream, fontWeight: '300', marginBottom: 8 },
  tierPill: { backgroundColor: 'rgba(201,165,90,0.15)', paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start', marginBottom: 6 },
  tierText: { fontSize: 10, color: COLORS.champagne, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase' },
  memberId: { fontSize: 13, color: 'rgba(166,124,82,0.6)', letterSpacing: 1 },
  statsRow: { flexDirection: 'row', backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: 'rgba(201,165,90,0.1)' },
  statBox: { flex: 1, padding: 18, alignItems: 'center', borderRightWidth: 1, borderRightColor: 'rgba(201,165,90,0.1)' },
  statNum: { fontSize: 30, color: COLORS.champagne, fontWeight: '300' },
  statLabel: { fontSize: 9, color: COLORS.latte, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase', marginTop: 2, textAlign: 'center' },
  bookBtn: { backgroundColor: COLORS.champagne, margin: 16, padding: 16, alignItems: 'center' },
  bookBtnText: { color: COLORS.espresso, fontWeight: '700', fontSize: 12, letterSpacing: 2.5 },
  card: { backgroundColor: '#fff', marginHorizontal: 16, marginBottom: 12, padding: 18, borderWidth: 1, borderColor: 'rgba(201,165,90,0.12)' },
  cardTitle: { fontSize: 10, fontWeight: '700', letterSpacing: 2, color: COLORS.latte, textTransform: 'uppercase', marginBottom: 14 },
  apptRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(201,165,90,0.07)' },
  apptDate: { fontSize: 16, color: COLORS.espresso, fontWeight: '300' },
  apptDetail: { fontSize: 12, color: COLORS.latte, marginTop: 2 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 2 },
  status_SCHEDULED: { backgroundColor: 'rgba(60,140,80,0.1)' },
  status_COMPLETED: { backgroundColor: 'rgba(201,165,90,0.1)' },
  status_CANCELLED: { backgroundColor: 'rgba(180,50,50,0.1)' },
  statusText: { fontSize: 9, fontWeight: '700', letterSpacing: 1, color: COLORS.latte, textTransform: 'uppercase' },
  emptyText: { fontSize: 13, color: COLORS.latte, fontStyle: 'italic' },
  announceRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(201,165,90,0.07)' },
  announceSubject: { fontSize: 13, fontWeight: '600', color: COLORS.espresso, marginBottom: 4 },
  announceBody: { fontSize: 12, color: COLORS.latte, lineHeight: 18 },
});
