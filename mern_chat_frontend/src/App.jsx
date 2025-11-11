// App.jsx
import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  createContext,
  useContext,
  useCallback,
} from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useNavigate,
} from "react-router-dom";
import axios from "axios";
import { io } from "socket.io-client";
import EmojiPicker from "emoji-picker-react";
import "./App.css";

// Backend URL
const API_URL =
  (typeof window !== "undefined" && window.__API_URL__) ||
  import.meta?.env?.VITE_API_URL ||
  "https://chatcat-238p.onrender.com";

// Axios setup
const api = axios.create({ baseURL: API_URL });
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0"
  )}`;
}

/* =======================
    AUTH CONTEXT
======================= */
const AuthContext = createContext(null);
function useAuth() {
  return useContext(AuthContext);
}
function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const raw = localStorage.getItem("user");
    return raw ? JSON.parse(raw) : null;
  });
  const [token, setToken] = useState(() => localStorage.getItem("token"));

  const login = useCallback((u, t) => {
    setUser(u);
    setToken(t);
    localStorage.setItem("user", JSON.stringify(u));
    localStorage.setItem("token", t);
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    setToken(null);
    localStorage.removeItem("user");
    localStorage.removeItem("token");
  }, []);

  const value = useMemo(() => ({ user, token, login, logout }), [
    user,
    token,
    login,
    logout,
  ]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/* =======================
    SOCKET CONTEXT
======================= */
const SocketContext = createContext(null);
function useSocket() {
  return useContext(SocketContext);
}
function SocketProvider({ children }) {
  const { user, token } = useAuth();
  const [socket, setSocket] = useState(null);

  useEffect(() => {
    if (!token || !user) return;

    const newSocket = io(API_URL, {
      transports: ["websocket"],
      withCredentials: true,
    });

    newSocket.on("connect", () => {
      newSocket.emit("setup", user);
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
      setSocket(null);
    };
  }, [token, user]);

  const value = useMemo(() => ({ socket }), [socket]);

  return (
    <SocketContext.Provider value={value}>{children}</SocketContext.Provider>
  );
}

/* =======================
    FIXED CALL MODAL
======================= */
function CallModal({ caller, callee, onClose, callAccepted, callType }) {
  const { user } = useAuth();
  const { socket } = useSocket();

  const pc = useRef(null);
  const localStream = useRef(null);
  const remoteStream = useRef(null);
  const localRef = useRef(null);
  const remoteRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const modalRef = useRef(null);

  const [inCall, setInCall] = useState(false);
  const [incoming, setIncoming] = useState(!!caller);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(callType === "video");
  const [hasLocalStream, setHasLocalStream] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [callDuration, setCallDuration] = useState(0);

  const callConstraints = useMemo(
    () => ({ audio: true, video: callType === "video" }),
    [callType]
  );

  // Initialize PeerConnection
  useEffect(() => {
    pc.current = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pc.current.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit("webrtc-ice-candidate", {
          to: callee?._id || caller?._id,
          from: user._id,
          candidate: e.candidate,
        });
      }
    };

    pc.current.ontrack = (e) => {
      if (!remoteStream.current) remoteStream.current = new MediaStream();
      e.streams[0].getTracks().forEach((t) =>
        remoteStream.current.addTrack(t)
      );
      if (remoteRef.current) {
        remoteRef.current.srcObject = remoteStream.current;
      }
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStream.current;
      }
    };

    return () => {
      if (pc.current) {
        pc.current.close();
        pc.current = null;
      }
    };
  }, [socket, caller, callee, user]);

  // Attach local video
  useEffect(() => {
    if (localRef.current && localStream.current) {
      localRef.current.srcObject = localStream.current;
    }
  }, [hasLocalStream]);

  // Call timer
  useEffect(() => {
    if (inCall) {
      const interval = setInterval(() => {
        setCallDuration((p) => p + 1);
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [inCall]);

  // Signaling handlers
  useEffect(() => {
    if (!socket) return;

    const handleOffer = async (data) => {
      try {
        await pc.current.setRemoteDescription(
          new RTCSessionDescription(data.offer)
        );
        const stream = await navigator.mediaDevices.getUserMedia(
          callConstraints
        );
        localStream.current = stream;
        setHasLocalStream(true);
        stream.getTracks().forEach((t) => pc.current.addTrack(t, stream));
        if (localRef.current) localRef.current.srcObject = stream;
        const answer = await pc.current.createAnswer();
        await pc.current.setLocalDescription(answer);
        socket.emit("webrtc-answer", { to: data.from, from: user._id, answer });
        setInCall(true);
      } catch (err) {
        console.error("handleOffer error", err);
      }
    };

    const handleAnswer = async (data) => {
      try {
        await pc.current.setRemoteDescription(
          new RTCSessionDescription(data.answer)
        );
        setInCall(true);
        const receivers = pc.current.getReceivers();
        const stream = new MediaStream();
        receivers.forEach((r) => r.track && stream.addTrack(r.track));
        if (remoteRef.current) remoteRef.current.srcObject = stream;
      } catch (err) {
        console.error("handleAnswer error", err);
      }
    };

    const handleCandidate = async (data) => {
      try {
        if (data.candidate) {
          await pc.current.addIceCandidate(
            new RTCIceCandidate(data.candidate)
          );
        }
      } catch (err) {
        console.error("ICE candidate error", err);
      }
    };

    const handlePeerLeave = () => {
      endCall();
    };

    socket.on("webrtc-offer", handleOffer);
    socket.on("webrtc-answer", handleAnswer);
    socket.on("webrtc-ice-candidate", handleCandidate);
    socket.on("peer-disconnected", handlePeerLeave);

    return () => {
      socket.off("webrtc-offer", handleOffer);
      socket.off("webrtc-answer", handleAnswer);
      socket.off("webrtc-ice-candidate", handleCandidate);
      socket.off("peer-disconnected", handlePeerLeave);
    };
  }, [socket, user, callConstraints]);

  // Start call
  const startCall = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(callConstraints);
      localStream.current = stream;
      setHasLocalStream(true);
      stream.getTracks().forEach((t) => pc.current.addTrack(t, stream));
      if (localRef.current) localRef.current.srcObject = stream;

      socket.emit("prepare-call", { to: callee._id, from: user._id });
      socket.once("ready-for-offer", async () => {
        const offer = await pc.current.createOffer();
        await pc.current.setLocalDescription(offer);
        socket.emit("webrtc-offer", { to: callee._id, from: user._id, offer });
      });
    } catch (err) {
      console.error("startCall error:", err);
    }
  }, [socket, user, callee, callConstraints]);

  // Incoming call prepare
  useEffect(() => {
    if (!socket) return;
    socket.on("prepare-call", ({ from }) => {
      socket.emit("ready-for-offer", { to: from });
    });
  }, [socket]);

  // Accept incoming call
  const acceptCall = () => {
    socket.emit("call-accepted", { to: caller._id, from: user._id });
    setIncoming(false);
  };

  // End call
  const endCall = useCallback(() => {
    if (pc.current) pc.current.close();
    if (localStream.current) {
      localStream.current.getTracks().forEach((t) => t.stop());
    }
    if (remoteStream.current) {
      remoteStream.current.getTracks().forEach((t) => t.stop());
    }
    socket.emit("end-call", { to: callee?._id || caller?._id });
    onClose();
  }, [socket, caller, callee, onClose]);

  // Listen for accepted call
  useEffect(() => {
    if (callee && callAccepted && !inCall) {
      setTimeout(() => startCall(), 100);
    }
  }, [callee, callAccepted, inCall, startCall]);

  const toggleMute = () => {
    setIsMuted((m) => !m);
    localStream.current?.getAudioTracks().forEach((t) => (t.enabled = isMuted));
  };

  const toggleVideo = () => {
    setIsVideoEnabled((v) => !v);
    localStream.current?.getVideoTracks().forEach((t) => (t.enabled = !isVideoEnabled));
  };

  const toggleFullScreen = () => {
    if (!modalRef.current) return;
    if (!document.fullscreenElement) {
      modalRef.current.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  const name = caller?.name || callee?.name || "User";
  const typeLabel = callType === "video" ? "Video Call" : "Voice Call";

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <audio ref={remoteAudioRef} autoPlay playsInline />
      <div
        ref={modalRef}
        className="bg-white rounded-xl p-6 w-[90%] md:w-[600px] flex flex-col items-center relative"
      >
        <button
          onClick={toggleFullScreen}
          className="absolute top-2 right-2 p-2 rounded-full hover:bg-gray-200"
        >
          ⛶
        </button>

        <h2 className="text-lg font-semibold mb-2">{name}</h2>
        <p className="text-gray-500 mb-4">
          {incoming
            ? `${name} is calling... (${typeLabel})`
            : inCall
            ? `${typeLabel} - ${formatDuration(callDuration)}`
            : "Connecting..."}
        </p>

        {callType === "video" && (
          <div className="flex gap-4 w-full">
            <video
              ref={localRef}
              autoPlay
              muted
              playsInline
              className="w-1/2 h-64 bg-black rounded-lg border"
            />
            <video
              ref={remoteRef}
              autoPlay
              playsInline
              className="w-1/2 h-64 bg-black rounded-lg border"
            />
          </div>
        )}

        {callType === "voice" && (
          <div className="w-full h-64 flex flex-col items-center justify-center">
            <div className="w-24 h-24 bg-[#0088cc] rounded-full text-white flex items-center justify-center text-3xl mb-4">
              {name.charAt(0).toUpperCase()}
            </div>
          </div>
        )}

        <div className="mt-6 flex gap-4">
          {incoming ? (
            <>
              <button
                onClick={acceptCall}
                className="bg-green-500 text-white px-6 py-2 rounded-full hover:bg-green-600"
              >
                Accept
              </button>
              <button
                onClick={endCall}
                className="bg-red-500 text-white px-6 py-2 rounded-full hover:bg-red-600"
              >
                Decline
              </button>
            </>
          ) : (
            <>
              {callType === "video" && (
                <button
                  onClick={toggleVideo}
                  className={`px-4 py-2 rounded-full ${
                    isVideoEnabled
                      ? "bg-blue-500 hover:bg-blue-600"
                      : "bg-red-500 hover:bg-red-600"
                  } text-white`}
                >
                  {isVideoEnabled ? "Camera On" : "Camera Off"}
                </button>
              )}
              <button
                onClick={toggleMute}
                className={`px-4 py-2 rounded-full ${
                  isMuted
                    ? "bg-red-500 hover:bg-red-600"
                    : "bg-blue-500 hover:bg-blue-600"
                } text-white`}
              >
                {isMuted ? "Unmute" : "Mute"}
              </button>
              <button
                onClick={endCall}
                className="bg-red-500 text-white px-6 py-2 rounded-full hover:bg-red-600"
              >
                End Call
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}



/* =======================
  UI COMPONENTS (Telegram Style)
======================= */
function Page({ children }) {
  return (
    <div className="min-h-screen bg-[#f0f2f5]">
      {children}
    </div>
  );
}

function Input({ label, ...props }) {
  return (
    <label className="block">
      {label && <div className="mb-2 text-sm font-medium text-gray-700">{label}</div>}
      <input 
        {...props} 
        className="w-full rounded-lg border border-gray-300 px-4 py-3 outline-none transition-all duration-200 focus:ring-2 focus:ring-[#0088cc] focus:border-[#0088cc] bg-white" 
      />
    </label>
  );
}

function Button({ children, className = "", variant = "primary", ...props }) {
  const baseStyles = "rounded-lg px-4 py-2 font-medium transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed";
  const variants = {
    primary: "bg-[#0088cc] text-white hover:bg-[#0077b3]",
    secondary: "bg-gray-200 text-gray-700 hover:bg-gray-300",
    danger: "bg-red-500 text-white hover:bg-red-600"
  };
  
  return (
    <button
      className={`${baseStyles} ${variants[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

function Card({ children, className = "" }) {
  return (
    <div className={`bg-white rounded-lg shadow-sm ${className}`}>
      {children}
    </div>
  );
}

/* =======================
  AUTH FORMS (Telegram Style)
======================= */
function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const onSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    
    try {
      const { data } = await api.post("/api/users/login", { email, password });
      const { token, ...u } = data;
      login(u, token);
      navigate("/chats");
    } catch (err) {
      setError(err?.response?.data?.message || "Login failed. Please check your credentials.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Page>
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="max-w-md w-full">
          <div className="bg-white rounded-2xl shadow-xl p-8">
              <div className="text-center mb-8">
                  <div className="w-16 h-16 bg-[#0088cc] rounded-full flex items-center justify-center mx-auto mb-4">
                    <span className="text-2xl text-white">✈️</span>
                    </div>
                  <h2 className="text-2xl font-bold text-gray-800">Welcome to ChatCat</h2>
                  <p className="text-gray-600 mt-2">Please sign in to your account</p>
                </div>
                
              <form className="space-y-6" onSubmit={onSubmit}>
                <div className="space-y-4">
                  <Input 
                    label="Email" 
                    type="email"
                    value={email} 
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Enter your email"
                    required
                  />
                  <Input 
                    label="Password" 
                    type="password"
                    value={password} 
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    required
                  />
                </div>
                  
                  {error && (
                    <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
                      {error}
                      </div>
                  )}
                  
                  <Button 
                    type="submit" 
                    className="w-full py-3" 
                    disabled={loading}
                  >
                    {loading ? (
                    <span className="flex items-center justify-center">
                      <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                      Signing in...
                    </span>
                  ) : "Sign In"}
                </Button>
              </form>
              
              <div className="text-center mt-6">
                <p className="text-gray-600">
                  Don't have an account?{" "}
                  <button 
                    type="button"
                    onClick={() => navigate("/register")}
                    className="text-[#0088cc] hover:underline font-medium"
                  >
                    Sign Up
                  </button>
                </p>
              </div>
            </div>
          </div>
          </div>
    </Page>
  );
}

function Register() {
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: ""
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleChange = (e) => {
    setFormData(prev => ({
      ...prev,
      [e.target.name]: e.target.value
    }));
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    if (formData.password !== formData.confirmPassword) {
      setError("Passwords do not match");
      setLoading(false);
      return;
    }

    if (formData.password.length < 6) {
      setError("Password must be at least 6 characters long");
      setLoading(false);
      return;
    }

    try {
      const { data } = await api.post("/api/users/register", {
        name: formData.name,
        email: formData.email,
        password: formData.password
      });
      const { token, ...u } = data;
      login(u, token);
      navigate("/chats");
    } catch (err) {
      setError(err?.response?.data?.message || "Registration failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Page>
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="max-w-md w-full">
          <div className="bg-white rounded-2xl shadow-xl p-8">
            <div className="text-center mb-8">
              <div className="w-16 h-16 bg-[#0088cc] rounded-full flex items-center justify-center mx-auto mb-4">
                <span className="text-2xl text-white">✈️</span>
              </div>
              <h2 className="text-2xl font-bold text-gray-800">Join ChatCat</h2>
              <p className="text-gray-600 mt-2">Create your account</p>
            </div>
            
            <form className="space-y-6" onSubmit={onSubmit}>
              <div className="space-y-4">
                <Input 
                  label="Full Name" 
                  name="name"
                  type="text"
                  value={formData.name} 
                  onChange={handleChange}
                  placeholder="Enter your full name"
                  required
                />
                <Input 
                  label="Email" 
                  name="email"
                  type="email"
                  value={formData.email} 
                  onChange={handleChange}
                  placeholder="Enter your email"
                  required
                />
                <Input 
                  label="Password" 
                  name="password"
                  type="password"
                    value={formData.password} 
                    onChange={handleChange}
                    placeholder="Create a password (min. 6 characters)"
                    required
                  />
                <Input 
                  label="Confirm Password" 
                  name="confirmPassword"
                    type="password"
                    value={formData.confirmPassword} 
                    onChange={handleChange}
                    placeholder="Confirm your password"
                    required
                  />
              </div>
              
              {error && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
                  {error}
                </div>
              )}
              
              <Button 
                type="submit" 
                className="w-full py-3" 
                disabled={loading}
              >
                {loading ? (
                  <span className="flex items-center justify-center">
                    <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    Creating account...
                  </span>
                  ) : "Create Account"}
              </Button>
            </form>
            
            <div className="text-center mt-6">
              <p className="text-gray-600">
                Already have an account?{" "}
                <button 
                  type="button"
                  onClick={() => navigate("/login")}
                  className="text-[#0088cc] hover:underline font-medium"
                >
                  Sign In
                </button>
              </p>
            </div>
          </div>
        </div>
        </div>
    </Page>
  );
}

/* =======================
  PRIVATE ROUTE
======================= */
function PrivateRoute({ children }) {
  const { token } = useAuth();
  return token ? children : <Navigate to="/login" replace />;
}

/* =======================
  CHATS PAGE (Unread Count Added)
======================= */
function ChatsPage() {
  const { user } = useAuth();
  const { socket } = useSocket();
  const [users, setUsers] = useState([]);
  const [query, setQuery] = useState("");
  const [chats, setChats] = useState([]);
  const [activeChat, setActiveChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showSearch, setShowSearch] = useState(false);

  // --- Call State ---
  const [showCallModal, setShowCallModal] = useState(false);
  const [caller, setCaller] = useState(null);
  const [callee, setCallee] = useState(null);
  const [callAccepted, setCallAccepted] = useState(false);
  const [callType, setCallType] = useState('video');

  // --- Call Handlers ---
  const closeCall = useCallback(() => {
    setShowCallModal(false);
    setCaller(null);
    setCallee(null);
    setCallAccepted(false);
  }, []);

  const initiateCall = (type) => {
    if (!activeChat || !socket) return;
    const otherUser = activeChat.users.find(u => u._id !== user._id);
    if (!otherUser) return;
    
    setCallType(type);
    setCallee(otherUser);
    setCallAccepted(false);
    setShowCallModal(true);
    
    socket.emit("call-user", { 
      to: otherUser._id, 
      from: user._id, 
      name: user.name,
      callType: type,
    });
  };

  // --- Socket Listeners for Calls ---
  useEffect(() => {
    if (!socket) return;

    const handleIncomingCall = ({ from, name, callType }) => {
      setCaller({ _id: from, name });
      setCallType(callType || 'video');
      setCallee(null); 
      setCallAccepted(false);
      setShowCallModal(true);
    };

    const handleCallAccepted = ({ from }) => {
      setCallAccepted(true);
    };

    const handleEndCall = () => {
      closeCall();
    };

    socket.on("incoming-call", handleIncomingCall);
    socket.on("call-accepted", handleCallAccepted);
    socket.on("end-call", handleEndCall);

    return () => {
      socket.off("incoming-call", handleIncomingCall);
      socket.off("call-accepted", handleCallAccepted);
      socket.off("end-call", handleEndCall);
    };
  }, [socket, closeCall]); 

  // Load chats
  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/api/chats");
        const chatsWithCount = data.map(chat => ({ ...chat, unreadCount: 0 }));
        setChats(chatsWithCount);
      } catch (error) {
        console.error("Failed to load chats:", error);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Search users
  const searchUsers = async () => {
    if (!query.trim()) {
      setUsers([]);
      return;
    }
    try {
      const { data } = await api.get(`/api/users?search=${query}`);
      setUsers(data);
    } catch (error) {
      console.error("Failed to search users:", error);
    }
  };

  // Open chat
  const openChatWith = async (userId) => {
    try {
      const { data } = await api.post("/api/chats", { userId });
      if (!chats.find(c => c._id === data._id)) {
        setChats([{ ...data, unreadCount: 0 }, ...chats]);
      }
      
      setChats(prevChats => prevChats.map(c => 
        c._id === data._id ? { ...c, unreadCount: 0 } : c
      ));
      
      setActiveChat(data);
      loadMessages(data._id);
      setUsers([]);
      setQuery("");
      setShowSearch(false);
    } catch (error) {
      console.error("Failed to open chat:", error);
    }
  };

  const handleChatClick = (chat) => {
    setActiveChat(chat);
    loadMessages(chat._id);
    
    setChats(prevChats => prevChats.map(c => 
      c._id === chat._id ? { ...c, unreadCount: 0 } : c
    ));
  };

  const loadMessages = async (chatId) => {
    if (socket) socket.emit("join chat", chatId);
    try {
      const { data } = await api.get(`/api/chats/${chatId}/messages`);
      setMessages(data);
    } catch (error) {
      console.error("Failed to load messages:", error);
    }
  };

  // Send message
  const sendMessage = async (text) => {
    if (!text.trim() || !activeChat) return;
    setSending(true);
    try {
      const { data } = await api.post("/api/chats/message", {
        chatId: activeChat._id,
        content: text,
      });
      setMessages((prev) => [...prev, data]);
      socket?.emit("new message", data);
      
      setChats(prevChats => prevChats.map(c => 
        c._id === data.chat._id ? { ...c, latestMessage: data } : c
      ));

    } catch (error) {
      console.error("Failed to send message:", error);
    } finally {
      setSending(false);
    }
  };

  // Listen for incoming messages
  useEffect(() => {
    if (!socket) return;
    
    const handleMessage = (message) => {
      setChats(prevChats => 
        prevChats.map(c => {
          if (c._id === message.chat._id) {
            const isChatActive = activeChat?._id === message.chat._id;
            return {
              ...c, 
              latestMessage: message,
              unreadCount: isChatActive ? 0 : (c.unreadCount || 0) + 1,
            };
          }
          return c;
        })
        .sort((a, b) => new Date(b.latestMessage?.createdAt || 0) - new Date(a.latestMessage?.createdAt || 0))
      );

      if (message.chat._id === activeChat?._id) {
        setMessages((prev) => [...prev, message]);
      }
    };
    
    socket.on("message received", handleMessage);
    return () => socket.off("message received", handleMessage);
  }, [socket, activeChat]);

  return (
    <Page>
      {showCallModal && (
        <CallModal
          caller={caller}
          callee={callee}
          onClose={closeCall}
          callAccepted={callAccepted}
          callType={callType}
        />
      )}

      <div className="flex h-screen">
        {/* Sidebar */}
        <div className={`${activeChat ? 'hidden md:flex' : 'flex'} flex-col w-full md:w-80 lg:w-96 bg-white border-r border-gray-200`}>
          {/* Sidebar Header */}
          <div className="p-4 border-b border-gray-200 bg-white">
            <div className="flex items-center justify-between">
              <h1 className="text-xl font-semibold text-gray-800">ChatCat</h1>
              <div className="flex items-center gap-2">
                <button 
                    onClick={() => setShowSearch(!showSearch)}
                    className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                  >
                    <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                      </svg>
                  </button>
                  <UserMenu />
                </div>
              </div>
            
            {showSearch && (
              <div className="mt-4 flex gap-2">
                  <input
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#0088cc] focus:border-[#0088cc] outline-none bg-gray-50"
                    placeholder="Search users..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && searchUsers()}
                  />
                  <Button 
                    onClick={searchUsers} 
                    className="px-3 py-2 whitespace-nowrap flex-shrink-0"
                  >
                    Search
                  </Button>
                </div>
              )}
            </div>

            {/* Search Results */}
            {users.length > 0 && (
              <div className="border-b border-gray-200">
                <div className="p-3 bg-gray-50 text-sm font-medium text-gray-600">Search Results</div>
                <div className="max-h-60 overflow-y-auto">
                  {users.map((u) => (
                    <div key={u._id} className="flex items-center p-3 hover:bg-gray-50 transition-colors cursor-pointer border-b border-gray-100">
                      <div className="w-10 h-10 bg-[#0088cc] rounded-full flex items-center justify-center text-white font-semibold mr-3">
                        {u.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-gray-800 truncate">{u.name}</div>
                        <div className="text-xs text-gray-500 truncate">{u.email}</div>
                      </div>
                      <Button 
                        onClick={() => openChatWith(u._id)}
                        className="px-3 py-1 text-sm whitespace-nowrap flex-shrink-0"
                      >
                          Message
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Chats List */}
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="flex justify-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#0088cc]"></div>
                  </div>
              ) : (
                <div>
                  {chats.length === 0 ? (
                    <div className="text-center py-8 text-gray-500">
                      <div className="text-4xl mb-2">💬</div>
                      <p>No chats yet</p>
                      <p className="text-sm">Search for users to start chatting!</p>
                    </div>
                  ) : (
                    chats
                      .sort((a, b) => new Date(b.latestMessage?.createdAt || b.createdAt || 0) - new Date(a.latestMessage?.createdAt || a.createdAt || 0))
                      .map((c) => (
                        <button
                          key={c._id}
                          onClick={() => handleChatClick(c)} 
                          className={`w-full text-left p-3 border-b border-gray-100 transition-all duration-200 ${
                            activeChat?._id === c._id 
                              ? "bg-blue-50" 
                              : "hover:bg-gray-50"
                          }`}
                        >
                          <div className="flex items-center">
                            <div className="w-12 h-12 bg-[#0088cc] rounded-full flex items-center justify-center text-white font-semibold mr-3 flex-shrink-0">
                              {chatTitle(c, user).charAt(0).toUpperCase()}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="font-medium text-gray-800 truncate">{chatTitle(c, user)}</div>
                                  {c.latestMessage && (
                                    <div className="text-sm text-gray-500 truncate mt-1">
                                      {c.latestMessage.content}
                                      </div>
                                  )}
                              </div>
                              <div className="flex flex-col items-end ml-2">
                                {c.latestMessage && (
                                    <div className="text-xs text-gray-400 whitespace-nowrap mb-1">
                                      {new Date(c.latestMessage.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                      </div>
                                  )}
                                  {(c.unreadCount || 0) > 0 && (
                                    <div className="w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center font-medium">
                                      {c.unreadCount}
                                      </div>
                                  )}
                              </div>
                          </div>
                        </button>
                      ))
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Chat Area */}
          <div className={`flex-1 flex flex-col ${!activeChat ? 'hidden md:flex' : 'flex'}`}>
            {activeChat ? (
              <ChatView 
                chat={activeChat} 
                messages={messages} 
                onSend={sendMessage} 
                sending={sending} 
                onStartCall={initiateCall} 
              />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center bg-gray-100">
                <div className="text-center">
                  <div className="w-24 h-24 bg-[#0088cc] rounded-full flex items-center justify-center mx-auto mb-6">
                    <span className="text-3xl text-white">✈️</span>
                  </div>
                  <h2 className="text-2xl font-bold text-gray-700 mb-2">Welcome to ChatCat</h2>
                  <p className="text-gray-500">Select a chat to start messaging</p>
                  </div>
            </div>
        )}
      </div>
    </div>
  </Page>
  );
}

function chatTitle(chat, me) {
  if (!chat) return "Loading...";
  if (chat.isGroupChat && chat.chatName) return chat.chatName;
  const other = chat.users?.find((u) => u._id !== me?._id);
  return other?.name || "Unknown User";
}

function ChatView({ chat, messages, onSend, sending, onStartCall }) {
  const { user } = useAuth();
  const [text, setText] = useState("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [file, setFile] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);
  const containerRef = useRef(null);
  const emojiPickerRef = useRef(null);

  const chatName = useMemo(() => chatTitle(chat, user), [chat, user]);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target)) {
        setShowEmojiPicker(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (text.trim()) {
      onSend(text);
      setText("");
      setShowEmojiPicker(false);
    }
  };

  const onEmojiClick = (emojiData) => {
    setText((prevText) => prevText + emojiData.emoji);
  };

  const toggleEmojiPicker = () => {
    setShowEmojiPicker((prev) => !prev);
  };

  // ✅ File upload handler with progress and IMAGE validation
  const handleFileChange = async (e) => {
    const selectedFile = e.target.files[0];
    if (!selectedFile) return;

    // --- ⭐️ MODIFICATION 1: Validate file type ---
    const allowedTypes = ["image/jpeg", "image/png", "image/gif"];
    if (!allowedTypes.includes(selectedFile.type)) {
      alert("Only images (JPG, PNG, GIF) can be uploaded.");
      if (fileInputRef.current) {
        fileInputRef.current.value = ""; // Reset the file input
      }
      return; // Stop the function
    }
    // --- End Modification 1 ---

    setFile(selectedFile);
    setUploadProgress(0);
    setUploading(true);

    const formData = new FormData();
    formData.append("file", selectedFile);

    try {
      const { data } = await api.post("/api/upload", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        onUploadProgress: (progressEvent) => {
          const percent = Math.round(
            (progressEvent.loaded * 100) / progressEvent.total
          );
          setUploadProgress(percent);
        },
      });

      await onSend(data.url);
    } catch (err) {
      console.error("File upload failed:", err);
      alert("File upload failed. Please try again.");
    } finally {
      setUploading(false);
      setFile(null);
      setUploadProgress(0);
      if (fileInputRef.current) {
        fileInputRef.current.value = ""; // Reset the file input
      }
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#e5ddd5] chat-bg relative">
      {/* Chat Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center">
        <div className="w-10 h-10 bg-[#0088cc] rounded-full flex items-center justify-center text-white font-semibold mr-3">
          {chatName.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1">
          <div className="font-semibold text-gray-800">{chatName}</div>
        </div>

        {!chat.isGroupChat && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => onStartCall("voice")}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              title="Start voice call"
            >
              📞
            </button>
            <button
              onClick={() => onStartCall("video")}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              title="Start video call"
            >
              🎥
            </button>
          </div>
        )}
      </div>

      {/* Messages */}
      <div ref={containerRef} className="flex-1 overflow-y-auto p-4 space-y-2">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500">
            <div className="text-4xl mb-2">👋</div>
            <p>No messages yet</p>
            <p className="text-sm">Send a message to start the conversation!</p>
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m._id} message={m} />)
        )}
      </div>

      {/* Emoji Picker */}
      {showEmojiPicker && (
        <div ref={emojiPickerRef} className="absolute bottom-20 left-4 z-50">
          <EmojiPicker
            onEmojiClick={onEmojiClick}
            width={350}
            height={400}
            previewConfig={{ showPreview: false }}
          />
        </div>
      )}

      {/* Upload Progress Bar */}
      {uploading && (
        <div className="absolute bottom-24 left-0 right-0 px-4">
          <div className="bg-gray-200 rounded-full h-3 w-full overflow-hidden">
            <div
              className="bg-[#0088cc] h-3 rounded-full transition-all duration-150"
              style={{ width: `${uploadProgress}%` }}
            ></div>
          </div>
          <div className="text-center text-xs text-gray-600 mt-1">
            Uploading {file?.name}... {uploadProgress}%
          </div>
        </div>
      )}

      {/* Message Input */}
      <div className="bg-white border-t border-gray-200 p-4">
        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleEmojiPicker}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            😀
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current.click()}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            title="Attach file"
          >
            📎
          </button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            className="hidden"
            // --- ⭐️ MODIFICATION 2: Add accept attribute ---
            accept="image/jpeg, image/png, image/gif"
            // --- End Modification 2 ---
          />

          <input
            className="flex-1 border border-gray-300 rounded-full px-4 py-3 focus:ring-2 focus:ring-[#0088cc] focus:border-[#0088cc] outline-none transition-all duration-200 bg-gray-50"
            placeholder="Type a message..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={sending || uploading}
          />

          <button
            type="submit"
            disabled={sending || !text.trim() || uploading}
            className="p-3 bg-[#0088cc] text-white rounded-full hover:bg-[#0077b3] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            ➤
          </button>
        </form>
      </div>
    </div>
  );
}function MessageBubble({ message }) {
  const { user } = useAuth();
  if (!message.sender) return null;

  const mine = message.sender?._id === user?._id;
  const content = message.content;

  // This logic is still fine, because your validation now *prevents*
  // isVideo or isFile from ever being true from a file upload.
  const isImage = /\.(jpg|jpeg|png|gif)$/i.test(content);
  const isVideo = /\.(mp4|webm)$/i.test(content);
  const isFile = content.startsWith("/uploads/") && !isImage && !isVideo;

  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[70%] rounded-2xl px-4 py-2 shadow-sm ${
          mine ? "bg-[#dcf8c6]" : "bg-white"
        }`}
      >
        {!mine && (
          <div className="text-xs font-semibold mb-1 text-[#0088cc]">
            {message.sender?.name}
          </div>
        )}

        {isImage ? (
          <img
            src={content}
            alt="shared"
            className="rounded-lg max-h-64 object-cover"
          />
        ) : isVideo ? (
          <video src={content} controls className="rounded-lg max-h-64" />
        ) : isFile ? (
          <a href={content} download className="text-blue-600 underline text-sm">
            📎 Download File
          </a>
        ) : (
          <div className="text-gray-800" style={{ whiteSpace: "pre-wrap" }}>
            {content}
          </div>
        )}

        <div
          className={`text-xs mt-1 ${
            mine ? "text-gray-500 text-right" : "text-gray-400"
          }`}
        >
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </div>
      </div>
    </div>
  );
}




function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);
  
  if (!user) return null;
  
  return (
    <div className="relative" ref={menuRef}>
      <button 
        onClick={() => setShowMenu(!showMenu)}
        className="w-8 h-8 bg-[#0088cc] rounded-full flex items-center justify-center text-white font-semibold hover:opacity-80 transition-opacity"
      >
        {user.name.charAt(0).toUpperCase()}
      </button>
      
      {showMenu && (
        <div className="absolute right-0 top-12 bg-white rounded-lg shadow-lg border border-gray-200 py-2 z-50 min-w-48">
          <div className="px-4 py-2 border-b border-gray-100">
            <div className="font-medium text-gray-800">{user.name}</div>
            <div className="text-sm text-gray-500">{user.email}</div>
          </div>
          <button 
            onClick={() => { logout(); navigate("/login"); }}
            className="w-full text-left px-4 py-2 text-red-600 hover:bg-gray-50 transition-colors"
          >
            Log Out
          </button>
        </div>
      )}
    </div>
  );
}

/* =======================
  MAIN ROUTES
======================= */
function App() {
  return (
    <AuthProvider>
      <SocketProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<HomeRedirect />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/chats" element={<PrivateRoute><ChatsPage /></PrivateRoute>} />
          </Routes>
        </BrowserRouter>
      </SocketProvider>
    </AuthProvider>
  );
}

function HomeRedirect() {
  const { token } = useAuth();
  return <Navigate to={token ? "/chats" : "/login"} replace />;
}

// This file only exports the App, main.jsx handles the rendering
export default App;
