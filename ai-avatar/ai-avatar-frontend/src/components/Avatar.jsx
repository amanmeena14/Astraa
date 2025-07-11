import { useAnimations, useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useChat } from '../hooks/useChat';

const expressionMap = {
  default: {},
  gentleSmile: { mouthSmileLeft: 0.4, mouthSmileRight: 0.4, eyeSquintLeft: 0.2, eyeSquintRight: 0.2 },
  // …add others as needed
};

const visemeMap = {
  A: 'viseme_AA', B: 'viseme_kk', C: 'viseme_I', D: 'viseme_AA',
  E: 'viseme_O', F: 'viseme_U', G: 'viseme_FF', H: 'viseme_TH', X: 'viseme_PP',
};

export function Avatar(props) {
  const group = useRef();
  const { message, onMessagePlayed } = useChat();
  const { nodes, materials } = useGLTF('/models/64f1a714fe61576b46f27ca2.glb');
  const { animations } = useGLTF('/models/animations.glb');
  const { actions } = useAnimations(animations, group);

  // playCounter bumps on each new message → forces all effects to re-run
  const [playCounter, setPlayCounter] = useState(0);

  // local state for current audio & data
  const [expr, setExpr] = useState('default');
  const [lipsync, setLipsync] = useState(null);
  const audioRef = useRef(null);

  // 1️⃣ When message arrives, bump counter & stash its details
  useEffect(() => {
    if (!message) return;
    setPlayCounter((c) => c + 1);
    setExpr(message.facialExpression || 'default');
    setLipsync(message.lipsync || null);

    // clean up old audio
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  }, [message]);

  // 2️⃣ Trigger animation & audio on playCounter change
  useEffect(() => {
    if (!message) return;

    const animName = message.animation || 'Idle';

    // fade out all then play this
    Object.values(actions).forEach((a) => a.fadeOut(0.2));
    const action = actions[animName];
    if (action) {
      action.reset().fadeIn(0.2).play();
    }

    // play audio
    if (message.audio) {
      const audio = new Audio('data:audio/mp3;base64,' + message.audio);
      audioRef.current = audio;
      audio.play().catch(console.error);
      audio.onended = onMessagePlayed;
    }
  }, [playCounter, actions, message, onMessagePlayed]);

  // 3️⃣ Per‑frame: blend expressions & lipsync
  useFrame(() => {
    // expressions
    const eMap = expressionMap[expr] || {};
    Object.values(nodes).forEach((node) => {
      if (node.isSkinnedMesh && node.morphTargetDictionary) {
        Object.entries(node.morphTargetDictionary).forEach(([key, idx]) => {
          const target = eMap[key] ?? 0;
          node.morphTargetInfluences[idx] = THREE.MathUtils.lerp(
            node.morphTargetInfluences[idx] || 0,
            target,
            0.1
          );
        });
      }
    });

    // lipsync
    const audio = audioRef.current;
    if (audio && lipsync?.mouthCues) {
      const t = audio.currentTime;
      const cue = lipsync.mouthCues.find((c) => t >= c.start && t <= c.end);
      const viseme = cue ? visemeMap[cue.value] : null;

      Object.values(nodes).forEach((node) => {
        if (node.isSkinnedMesh && node.morphTargetDictionary) {
          Object.values(visemeMap).forEach((vm) => {
            const idx = node.morphTargetDictionary[vm];
            if (idx != null) {
              const val = vm === viseme ? 1 : 0;
              node.morphTargetInfluences[idx] = THREE.MathUtils.lerp(
                node.morphTargetInfluences[idx],
                val,
                0.2
              );
            }
          });
        }
      });
    }
  });

  return (
    <group {...props} ref={group} dispose={null}>
      <primitive object={nodes.Hips} />
      {Object.entries(nodes).map(([key, node]) =>
        node.isSkinnedMesh ? (
          <skinnedMesh
            key={key}
            geometry={node.geometry}
            material={materials[node.material?.name]}
            skeleton={node.skeleton}
            morphTargetDictionary={node.morphTargetDictionary}
            morphTargetInfluences={node.morphTargetInfluences}
          />
        ) : null
      )}
    </group>
  );
}

useGLTF.preload('/models/64f1a714fe61576b46f27ca2.glb');
useGLTF.preload('/models/animations.glb');
