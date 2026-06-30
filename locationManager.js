const studentLocations = {};

/* =========================
   🌍 DISTANCE (HAVERSINE)
========================= */
function calculateDistance(lat1, lon1, lat2, lon2) {
  if (
    lat1 == null ||
    lon1 == null ||
    lat2 == null ||
    lon2 == null
  ) return Infinity;

  const R = 6371; // Earth radius in KM
  const toRad = (value) => (value * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // KM
}

/* =========================
   🧠 STUDENT UPDATE
========================= */
function updateStudentLocation({
  studentId,
  busId,
  lat,
  lng,
  fcmToken,
}) {
  if (!studentId || !busId || lat == null || lng == null) {
    return false;
  }

  studentLocations[studentId] = {
    studentId,
    busId,
    lat: Number(lat),
    lng: Number(lng),
    fcmToken: fcmToken || null,
    lastUpdated: Date.now(),
    notified5km: false,
  };

  return true;
}

/* =========================
   🔍 GET STUDENTS BY BUS
========================= */
function getStudentsByBus(busId) {
  return Object.values(studentLocations).filter(
    (s) => s.busId === busId
  );
}

/* =========================
   🔁 RESET DISTANCE FLAGS
========================= */
function resetNotification(studentId) {
  if (studentLocations[studentId]) {
    studentLocations[studentId].notified5km = false;
    studentLocations[studentId].lastUpdated = Date.now();
  }
}

module.exports = {
  studentLocations,
  calculateDistance,
  updateStudentLocation,
  getStudentsByBus,
  resetNotification,
};