import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { COLORS } from '../theme';

export default function HistoryScreen() {
  const { refreshProfile } = useAuth();
  const [history, setHistory] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    const d = await refreshProfile();
    if (d?.history) setHistory(d.history);
  }

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <Text style={s.logo}>ZOLA</Text>
        <Text style={s.title}>Nail History</Text>
      </View>
      <ScrollView style={s.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.champagne} />}>
        <View style={s.card}>
          <Text style={s.cardTitle}>ALL APPOINTMENTS</Text>
          {history.length ? history.map((h, i) => (
            <View key={i} style={s.row}>
              <Text style={s.date}>{new Date(h.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</Text>
              <Text style={s.detail}>{[h.service, h.shape, h.length, h.color].filter(Boolean).join(' · ')}</Text>
              {h.allergies && <Text style={s.allergy}>Allergies: {h.allergies}</Text>}
            </View>
          )) : (
            <Text style={s.empty}>No appointment history yet.</Text>
          )}
        </View>
        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.softWhite },
  header: { backgroundColor: COLORS.espresso, padding: 20 },
  logo: { fontSize: 16, color: COLORS.champagne, letterSpacing: 4, fontWeight: '300', marginBottom: 4 },
  title: { fontSize: 22, color: COLORS.cream, fontWeight: '300' },
  scroll: { flex: 1 },
  card: { backgroundColor: '#fff', margin: 16, padding: 18, borderWidth: 1, borderColor: 'rgba(201,165,90,0.12)' },
  cardTitle: { fontSize: 10, fontWeight: '700', letterSpacing: 2, color: COLORS.latte, textTransform: 'uppercase', marginBottom: 14 },
  row: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(201,165,90,0.07)' },
  date: { fontSize: 16, color: COLORS.espresso, fontWeight: '300' },
  detail: { fontSize: 12, color: COLORS.latte, marginTop: 3 },
  allergy: { fontSize: 11, color: '#b43232', marginTop: 3 },
  empty: { fontSize: 13, color: COLORS.latte, fontStyle: 'italic' },
});
