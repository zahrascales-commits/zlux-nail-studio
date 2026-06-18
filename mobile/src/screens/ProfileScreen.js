import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, TextInput, Share } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { COLORS, API_BASE, TIER_LABEL } from '../theme';

export default function ProfileScreen() {
  const { member, token, logout, refreshProfile } = useAuth();
  const [prefs, setPrefs] = useState({});
  const [referral, setReferral] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    const [p, r] = await Promise.all([
      refreshProfile(),
      axios.get(`${API_BASE}/api/referral`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null),
    ]);
    if (p?.preferences) setPrefs(p.preferences);
    if (r?.data) setReferral(r.data);
  }

  async function savePrefs() {
    try {
      await axios.put(`${API_BASE}/api/member-profile`, { preferences: {
        shape: prefs.preferred_shape,
        length: prefs.preferred_length,
        allergies: prefs.allergies,
        sensitivities: prefs.sensitivities,
        notes: prefs.notes,
      }}, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (_) {}
  }

  async function shareReferral() {
    if (!referral?.referralLink) return;
    await Share.share({ message: `Join Zola — luxury nail membership in Porterville. Use my link: ${referral.referralLink}` });
  }

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <Text style={s.logo}>ZOLA</Text>
        <Text style={s.title}>My Profile</Text>
      </View>
      <ScrollView style={s.scroll}>

        <View style={s.card}>
          <Text style={s.cardTitle}>ACCOUNT</Text>
          <View style={s.detailRow}><Text style={s.detailLabel}>NAME</Text><Text style={s.detailVal}>{member?.fullName}</Text></View>
          <View style={s.detailRow}><Text style={s.detailLabel}>MEMBER ID</Text><Text style={[s.detailVal, { color: COLORS.champagne, fontSize: 20 }]}>{member?.memberId}</Text></View>
          <View style={s.detailRow}><Text style={s.detailLabel}>EMAIL</Text><Text style={s.detailVal}>{member?.email}</Text></View>
          <View style={s.detailRow}><Text style={s.detailLabel}>TIER</Text><Text style={[s.detailVal, { color: COLORS.champagne }]}>{TIER_LABEL[member?.tier]}</Text></View>
          <View style={[s.detailRow, { borderBottomWidth: 0 }]}><Text style={s.detailLabel}>NEXT BILLING</Text><Text style={s.detailVal}>{member?.nextBilling ? new Date(member.nextBilling).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '—'}</Text></View>
        </View>

        <View style={s.card}>
          <Text style={s.cardTitle}>NAIL PREFERENCES</Text>
          <Text style={s.inputLabel}>PREFERRED SHAPE</Text>
          <TextInput style={s.input} value={prefs.preferred_shape || ''} onChangeText={v => setPrefs(p => ({...p, preferred_shape: v}))} placeholder="almond, square, coffin…" placeholderTextColor="rgba(166,124,82,0.4)" />
          <Text style={s.inputLabel}>PREFERRED LENGTH</Text>
          <TextInput style={s.input} value={prefs.preferred_length || ''} onChangeText={v => setPrefs(p => ({...p, preferred_length: v}))} placeholder="short / medium / long" placeholderTextColor="rgba(166,124,82,0.4)" />
          <Text style={s.inputLabel}>ALLERGIES</Text>
          <TextInput style={s.input} value={prefs.allergies || ''} onChangeText={v => setPrefs(p => ({...p, allergies: v}))} placeholder="any product allergies" placeholderTextColor="rgba(166,124,82,0.4)" />
          <Text style={s.inputLabel}>SENSITIVITIES</Text>
          <TextInput style={s.input} value={prefs.sensitivities || ''} onChangeText={v => setPrefs(p => ({...p, sensitivities: v}))} placeholder="e.g. sensitive skin, thin nails" placeholderTextColor="rgba(166,124,82,0.4)" />
          <Text style={s.inputLabel}>NOTES FOR ARTIST</Text>
          <TextInput style={[s.input, { minHeight: 60 }]} value={prefs.notes || ''} onChangeText={v => setPrefs(p => ({...p, notes: v}))} placeholder="anything else your artist should know" placeholderTextColor="rgba(166,124,82,0.4)" multiline />
          <TouchableOpacity style={s.saveBtn} onPress={savePrefs}>
            <Text style={s.saveBtnText}>{saved ? 'SAVED ✓' : 'SAVE PREFERENCES'}</Text>
          </TouchableOpacity>
        </View>

        {referral && (
          <View style={s.card}>
            <Text style={s.cardTitle}>REFERRALS</Text>
            <Text style={s.refDesc}>Share your unique link. When someone joins Zola using it, you receive a credit on your account.</Text>
            <Text style={s.refLink}>{referral.referralLink || '—'}</Text>
            <Text style={s.refCount}>Successful referrals: {referral.completed || 0}</Text>
            <TouchableOpacity style={s.shareBtn} onPress={shareReferral}>
              <Text style={s.shareBtnText}>SHARE MY REFERRAL LINK</Text>
            </TouchableOpacity>
          </View>
        )}

        <TouchableOpacity style={s.logoutBtn} onPress={logout}>
          <Text style={s.logoutText}>Sign Out</Text>
        </TouchableOpacity>
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
  card: { backgroundColor: '#fff', margin: 16, marginBottom: 0, padding: 18, borderWidth: 1, borderColor: 'rgba(201,165,90,0.12)' },
  cardTitle: { fontSize: 10, fontWeight: '700', letterSpacing: 2, color: COLORS.latte, textTransform: 'uppercase', marginBottom: 14 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(201,165,90,0.07)' },
  detailLabel: { fontSize: 9, fontWeight: '700', color: COLORS.latte, letterSpacing: 1.5, textTransform: 'uppercase' },
  detailVal: { fontSize: 14, color: COLORS.espresso, fontWeight: '300', maxWidth: '65%', textAlign: 'right' },
  inputLabel: { fontSize: 9, fontWeight: '700', color: COLORS.latte, letterSpacing: 1.5, textTransform: 'uppercase', marginTop: 12, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: 'rgba(201,165,90,0.22)', padding: 10, fontSize: 14, color: COLORS.espresso, backgroundColor: COLORS.softWhite },
  saveBtn: { backgroundColor: COLORS.champagne, padding: 14, alignItems: 'center', marginTop: 16 },
  saveBtnText: { color: COLORS.espresso, fontWeight: '700', fontSize: 11, letterSpacing: 2 },
  refDesc: { fontSize: 13, color: COLORS.latte, lineHeight: 20, marginBottom: 12 },
  refLink: { fontSize: 14, color: COLORS.champagne, marginBottom: 8 },
  refCount: { fontSize: 12, color: COLORS.latte, marginBottom: 14 },
  shareBtn: { borderWidth: 1, borderColor: COLORS.champagne, padding: 12, alignItems: 'center' },
  shareBtnText: { fontSize: 11, color: COLORS.champagne, fontWeight: '700', letterSpacing: 1.5 },
  logoutBtn: { margin: 16, marginTop: 20, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(166,124,82,0.2)' },
  logoutText: { fontSize: 12, color: COLORS.latte, letterSpacing: 1 },
});
