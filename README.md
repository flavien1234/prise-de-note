# Prise de notes ✍️⌨️

Une application de prise de notes où **plusieurs appareils éditent le même document en même temps** :

- 💻 sur l'**ordinateur**, vous **tapez au clavier** ;
- 📱 sur l'**iPad**, vous **écrivez / dessinez avec l'Apple Pencil** (pression prise en compte) ;
- tout apparaît **en direct** sur les deux écrans, sur la même page (le trait s'affiche pendant que vous l'écrivez).

## Démarrage

Il faut [Node.js](https://nodejs.org) 18 ou plus récent, installé sur l'ordinateur. Aucune autre dépendance.

```bash
node server.js        # ou : npm start
```

Le terminal affiche deux adresses :

```
Sur cet ordinateur :      http://localhost:3000
Sur l'iPad (même Wi-Fi) : http://192.168.1.42:3000
```

1. Sur l'ordinateur, ouvrez `http://localhost:3000` dans le navigateur.
2. Sur l'iPad (connecté au **même Wi-Fi**), ouvrez la seconde adresse dans Safari.
3. Dans Safari : **Partager → Sur l'écran d'accueil**. La note s'ouvre alors en plein écran, comme une vraie app.
4. Ouvrez la même note sur les deux appareils. L'indicateur « 2 appareils » confirme la connexion.

## Utilisation

| Outil | Ordinateur | iPad |
|---|---|---|
| **T** Texte | taper au clavier | taper ; avec le Pencil, **Scribble** convertit l'écriture en texte |
| ✏️ Stylo | dessiner à la souris | écrire avec le Pencil (le doigt fait défiler la page) |
| 🖍 Surligneur | surligner | surligner (le texte reste lisible dessous) |
| 🧽 Gomme | effacer des traits | effacer des traits |

- **Raccourcis de mise en forme** : `# ` titre, `## ` sous-titre, `- ` liste, `[] ` case à cocher, ⌘B / ⌘I / ⌘U.
- **Raccourcis d'outils** (hors du texte) : `T`, `P`, `H`, `E`. Annuler / rétablir un trait : ⌘Z / ⇧⌘Z.
- Menu `•••` : type de papier (lignes, carreaux, points, blanc), dessin au doigt, suppression de la note.
- Les notes sont enregistrées dans le dossier `data/` (un fichier JSON par note).

## Fonctionnement

- `server.js` : petit serveur Node sans dépendance. Il sert l'app et relaie les modifications en temps réel (Server-Sent Events).
- Le **texte** est synchronisé paragraphe par paragraphe. Deux personnes peuvent écrire en même temps dans des paragraphes différents.
- L'**encre** est stockée en coordonnées de page (page de 800 px logiques, mise à l'échelle sur chaque écran), donc une annotation reste au même endroit sur tous les appareils.
- Après une coupure réseau, les modifications sont mises en attente et renvoyées à la reconnexion.

Options : `PORT=4000 node server.js`, `DATA_DIR=/chemin/vers/mes-notes node server.js`.

## Limites

- Pas de mot de passe : n'utilisez le serveur que sur un réseau de confiance (votre Wi-Fi à la maison ou au bureau).
- L'ordinateur qui fait tourner `server.js` doit rester allumé pendant que vous prenez des notes.
- Si deux appareils modifient **le même paragraphe** à la même seconde, la dernière version enregistrée l'emporte.
- L'encre est placée sur la page, elle n'est pas attachée au texte. Si vous insérez beaucoup de texte au-dessus d'une annotation, le texte se décale mais l'annotation reste en place.
