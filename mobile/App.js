import React, { useEffect, useRef } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createStackNavigator } from '@react-navigation/stack';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Text, View } from 'react-native';

import { COLORS } from './src/theme';
import HomeScreen from './src/screens/HomeScreen';
import QRScreen from './src/screens/QRScreen';
import BookScreen from './src/screens/BookScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import LoginScreen from './src/screens/LoginScreen';
import { AuthProvider, useAuth } from './src/context/AuthContext';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

const Tab = createBottomTabNavigator();
const Stack = createStackNavigator();

function TabIcon({ name, color }) {
  const icons = { Home: '⌂', QR: '▣', Book: '📅', History: '◷', Profile: '☆' };
  return <Text style={{ fontSize: 18, color }}>{icons[name] || '●'}</Text>;
}

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: { backgroundColor: COLORS.espresso, borderTopColor: 'rgba(201,165,90,0.15)', height: 60, paddingBottom: 6 },
        tabBarActiveTintColor: COLORS.champagne,
        tabBarInactiveTintColor: 'rgba(166,124,82,0.5)',
        tabBarLabelStyle: { fontFamily: 'System', fontSize: 9, fontWeight: '600', letterSpacing: 0.8 },
        tabBarIcon: ({ color }) => <TabIcon name={route.name} color={color} />,
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="QR" component={QRScreen} options={{ tabBarLabel: 'My QR' }} />
      <Tab.Screen name="Book" component={BookScreen} />
      <Tab.Screen name="History" component={HistoryScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}

function AppNavigator() {
  const { isLoggedIn, isLoading } = useAuth();

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: COLORS.espresso, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontFamily: 'System', fontSize: 28, color: COLORS.champagne, letterSpacing: 4 }}>ZOLA</Text>
      </View>
    );
  }

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {isLoggedIn ? (
        <Stack.Screen name="Main" component={MainTabs} />
      ) : (
        <Stack.Screen name="Login" component={LoginScreen} />
      )}
    </Stack.Navigator>
  );
}

export default function App() {
  const notificationListener = useRef();
  const responseListener = useRef();

  useEffect(() => {
    registerForPushNotifications();

    notificationListener.current = Notifications.addNotificationReceivedListener(() => {});
    responseListener.current = Notifications.addNotificationResponseReceivedListener(() => {});

    return () => {
      Notifications.removeNotificationSubscription(notificationListener.current);
      Notifications.removeNotificationSubscription(responseListener.current);
    };
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <NavigationContainer>
            <StatusBar style="light" backgroundColor={COLORS.espresso} />
            <AppNavigator />
          </NavigationContainer>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

async function registerForPushNotifications() {
  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;
  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== 'granted') return;
  const token = (await Notifications.getExpoPushTokenAsync()).data;
  if (token) await SecureStore.setItemAsync('expo_push_token', token);
}
