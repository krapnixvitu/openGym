/* The map of openGym the server hands the client once, at connection (the MCP `instructions`
   field): how a profile fits together and how to use the tools well, which no single tool
   description can say. Kept short, because clients put it into the model's context every
   session, and kept to what the tools do today: a new tool group adds its line here. No em
   dashes: this is text the model reads, and may echo. */
export const INSTRUCTIONS = `openGym is a self-hosted gym and body-weight tracker. These tools read and change one person's profile, the same data their phone and the web app show.

How a profile fits together:
- Routines are saved plans: exercises with set, rep and weight targets. The week plan says which routine is planned on which day (a weekday table, single-day overrides, or a coach week or rotation).
- Workouts are finished sessions in the history, each with an id, a date and per-set rows. A day can hold more than one workout, so use ids, not dates, once you have them.
- Exercises come from a library of over 5,600 plus the person's own custom ones, and are identified by id. Names can be ambiguous ("shoulder press"), so check the name a tool answers with.
- Weights are in the profile's unit (kg or lb), as the tools report it. Warm-up sets do not count towards PRs or the next suggested weight, and by default not towards volume.
- Progression rules decide the weight and reps of the next session. What a routine stores and what the app will actually prescribe next can differ: ask preview_session before naming a weight for next time, not get_routine.

Using the tools:
- Look things up before acting: list_routines, list_workouts and get_week_plan give the ids the other tools take.
- Answers about training use the same calculations as the app's own screens, so prefer them to working numbers out yourself.
- Writing tools change the person's real data on every device within about half a minute. When you had to interpret what they said, call the tool with dry_run: true first, show the result, and save only once they agree.
- A routine's exercises are slots, numbered from 1 in get_routine's order. edit_routine makes its changes in order, each on the routine as the one before left it; restore_routine undoes the last routine change.
- When a tool answers with problems or candidates, put the choice to the person instead of guessing.`
