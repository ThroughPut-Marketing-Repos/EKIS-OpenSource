import { Op } from 'sequelize';
import logger from '../utils/logger.js';
import { getModels } from '../database/index.js';

export const saveSnapshot = async (uid, exchange, totalVolume, kolName = null, depositAmount = null, exchangeId = null) => {
  const { VolumeSnapshot } = getModels();
  return VolumeSnapshot.create({ uid, exchange, totalVolume, kolName, depositAmount, exchangeId });
};

export const saveSnapshotsBatch = async (snapshots) => {
  if (!snapshots || snapshots.length === 0) {
    return [];
  }

  const { VolumeSnapshot } = getModels();

  const snapshotData = snapshots.map((snapshot) => ({
    uid: snapshot.uid,
    exchange: snapshot.exchange,
    exchangeId: snapshot.exchangeId ?? null,
    totalVolume: snapshot.totalVolume,
    kolName: snapshot.kolName,
    depositAmount: snapshot.depositAmount,
    createdAt: new Date(),
    updatedAt: new Date()
  }));

  return VolumeSnapshot.bulkCreate(snapshotData);
};

export const getLatestSnapshot = async (uid, exchange) => {
  const { VolumeSnapshot } = getModels();
  return VolumeSnapshot.findOne({
    where: { uid, exchange },
    order: [['createdAt', 'DESC']]
  });
};

export const getVolumeForLast30Days = async (uid, exchange) => {
  const { VolumeSnapshot } = getModels();
  const now = new Date();
  const thirtyAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const latest = await VolumeSnapshot.findOne({
    where: { uid, exchange },
    order: [['createdAt', 'DESC']]
  });
  if (!latest) {
    return 0;
  }

  const old = await VolumeSnapshot.findOne({
    where: { uid, exchange, createdAt: { [Op.lte]: thirtyAgo } },
    order: [['createdAt', 'DESC']]
  });

  const parseVolume = (value) => (value ? parseFloat(value) : 0);

  if (old) {
    return parseVolume(latest.totalVolume) - parseVolume(old.totalVolume);
  }

  const oldest = await VolumeSnapshot.findOne({
    where: { uid, exchange },
    order: [['createdAt', 'ASC']]
  });

  if (!oldest || oldest.id === latest.id) {
    return parseVolume(latest.totalVolume);
  }

  return parseVolume(latest.totalVolume) - parseVolume(oldest.totalVolume);
};

export const getVolumeBetween = async (uid, exchange, startTime, endTime) => {
  const { VolumeSnapshot } = getModels();
  logger.debug(`[getVolumeBetween] uid=${uid} exchange=${exchange} start=${startTime} end=${endTime}`);

  if (!startTime) {
    logger.warn(`Invalid time parameters for UID ${uid}: startTime=${startTime}`);
    return 0;
  }

  const startDate = new Date(startTime);
  const endDate = new Date(endTime || Date.now());

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    logger.warn(`Invalid date conversion for UID ${uid}: start=${startTime} end=${endTime}`);
    return 0;
  }

  const latest = await VolumeSnapshot.findOne({
    where: { uid, exchange, createdAt: { [Op.lte]: endDate } },
    order: [['createdAt', 'DESC']]
  });
  if (!latest) {
    return 0;
  }

  const old = await VolumeSnapshot.findOne({
    where: { uid, exchange, createdAt: { [Op.lte]: startDate } },
    order: [['createdAt', 'DESC']]
  });

  if (!old || old.id === latest.id) {
    return 0;
  }

  const volumeDifference = (parseFloat(latest.totalVolume) || 0) - (parseFloat(old.totalVolume) || 0);
  return Math.max(0, volumeDifference);
};

export const getVolumeBetweenBatch = async (uids, exchange, startTime, endTime) => {
  const { VolumeSnapshot } = getModels();

  if (!uids || uids.length === 0) {
    return {};
  }

  if (!startTime) {
    logger.warn(`Invalid time parameters for batch calculation: startTime=${startTime}`);
    return {};
  }

  const startDate = new Date(startTime);
  const endDate = new Date(endTime || Date.now());

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    logger.warn(`Invalid date conversion for batch calculation: start=${startTime} end=${endTime}`);
    return {};
  }

  const latestSnapshots = await VolumeSnapshot.findAll({
    where: {
      uid: { [Op.in]: uids },
      exchange,
      createdAt: { [Op.lte]: endDate }
    },
    order: [['uid', 'ASC'], ['createdAt', 'DESC']]
  });

  const oldSnapshots = await VolumeSnapshot.findAll({
    where: {
      uid: { [Op.in]: uids },
      exchange,
      createdAt: { [Op.lte]: startDate }
    },
    order: [['uid', 'ASC'], ['createdAt', 'DESC']]
  });

  const latestByUid = {};
  const oldByUid = {};

  for (const snapshot of latestSnapshots) {
    if (!latestByUid[snapshot.uid]) {
      latestByUid[snapshot.uid] = snapshot;
    }
  }

  for (const snapshot of oldSnapshots) {
    if (!oldByUid[snapshot.uid]) {
      oldByUid[snapshot.uid] = snapshot;
    }
  }

  const volumes = {};

  for (const uidKey of uids) {
    const latest = latestByUid[uidKey];
    const old = oldByUid[uidKey];

    if (!latest || !old || latest.id === old.id) {
      volumes[uidKey] = 0;
    } else {
      const volumeDifference = (parseFloat(latest.totalVolume) || 0) - (parseFloat(old.totalVolume) || 0);
      volumes[uidKey] = Math.max(0, volumeDifference);
    }
  }

  return volumes;
};

export default {
  saveSnapshot,
  saveSnapshotsBatch,
  getLatestSnapshot,
  getVolumeForLast30Days,
  getVolumeBetween,
  getVolumeBetweenBatch
};
