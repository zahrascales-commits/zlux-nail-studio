import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, KeyboardAvoidingView, Platform, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { COLORS } from '../theme';

export default function LoginScreen() {
  const { login } = useAuth();
  const [memberId, setMemberId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    setError('');
    if (!memberId.trim() || !password) { setError('Member ID and password are required.'); return; }
    setLoading(true);
    try {
      await login(memberId.trim().toUpperCase(), password);
    } catch (e) {
      setError(e?.response?.data?.error || 'Login failed. Check your credentials.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={s.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={s.scroll}>
          <View style={s.logoWrap}>
            <Text style={s.logo}>ZOLA</Text>
            <Text style={s.logoSub}>Nail Studio · Porterville, CA</Text>
          </View>
          <View style={s.card}>
            <Text style={s.heading}>Welcome Back</Text>
            <Text style={s.sub}>Sign in with your Member ID and password.</Text>
            {!!error && <View style={s.errBox}><Text style={s.errText}>{error}</Text></View>}
            <Text style={s.label}>MEMBER ID</Text>
            <TextInput
              style={s.input}
              value={memberId}
              onChangeText={t => setMemberId(t.toUpperCase())}
              placeholder="ZL-XXXXXX"
              placeholderTextColor="rgba(166,124,82,0.45)"
              autoCapitalize="characters"
              autoCorrect={false}
            />
            <Text style={s.label}>PASSWORD</Text>
            <TextInput
              style={s.input}
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              placeholderTextColor="rgba(166,124,82,0.45)"
              secureTextEntry
              onSubmitEditing={handleLogin}
            />
            <TouchableOpacity style={[s.btn, loading && s.btnDisabled]} onPress={handleLogin} disabled={loading}>
              {loading ? <ActivityIndicator color={COLORS.espresso} /> : <Text style={s.btnText}>SIGN IN</Text>}
            </TouchableOpacity>
            <Text style={s.joinLink}>Not a member? Visit zola-nail-studio.vercel.app to join.</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.espresso },
  scroll: { flexGrow: 1, padding: 24, justifyContent: 'center' },
  logoWrap: { alignItems: 'center', marginBottom: 40 },
  logo: { fontSize: 36, color: COLORS.champagne, letterSpacing: 8, fontWeight: '300' },
  logoSub: { fontSize: 11, color: 'rgba(166,124,82,0.6)', letterSpacing: 2, marginTop: 6, textTransform: 'uppercase' },
  card: { backgroundColor: '#fff', padding: 28, borderWidth: 1, borderColor: 'rgba(201,165,90,0.15)' },
  heading: { fontSize: 26, color: COLORS.espresso, marginBottom: 4, fontWeight: '300' },
  sub: { fontSize: 13, color: COLORS.latte, marginBottom: 24, lineHeight: 20 },
  errBox: { backgroundColor: 'rgba(180,50,50,0.08)', borderWidth: 1, borderColor: 'rgba(180,50,50,0.2)', padding: 10, marginBottom: 16 },
  errText: { fontSize: 13, color: '#b43232' },
  label: { fontSize: 10, fontWeight: '700', letterSpacing: 2, color: COLORS.latte, marginBottom: 6, textTransform: 'uppercase' },
  input: { borderWidth: 1, borderColor: 'rgba(201,165,90,0.22)', padding: 12, fontSize: 15, color: COLORS.espresso, marginBottom: 18, backgroundColor: COLORS.softWhite },
  btn: { backgroundColor: COLORS.champagne, padding: 15, alignItems: 'center', marginTop: 8 },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: COLORS.espresso, fontWeight: '700', fontSize: 12, letterSpacing: 2.5 },
  joinLink: { fontSize: 11, color: 'rgba(166,124,82,0.6)', textAlign: 'center', marginTop: 20, lineHeight: 18 },
});
