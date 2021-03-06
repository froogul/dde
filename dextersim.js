/* Created by Fry on 3/30/16.*/
//whole file loaded in ui env only as is tcp
DexterSim = class DexterSim{
    constructor(robot_name){ //called once per DDE session per robot_name by create_or_just_init
        this.robot_name = robot_name
        this.robot      = Robot[robot_name] //only used by predict_move_dur
        this.robot_status_in_arcseconds = Dexter.make_default_status_array()
        this.parameters = {}
        this.write_array = new Array(128)
        DexterSim.robot_name_to_dextersim_instance_map[robot_name] = this
    }

    static init_all(){ //called once per DDE session (normally)
        DexterSim.robot_name_to_dextersim_instance_map = {}
        DexterSim.set_interval_id = setInterval(DexterSim.process_next_instructions, 10)
    }

    init(sim_actual){
        this.sim_actual = sim_actual
        this.ending_time_of_cur_instruction = 0
        this.instruction_queue = []
        this.completed_instructions = []
        this.status = "before_first_send"
        this.ready_to_start_new_instruction = true  //true at beginning and when we've just completed an instruction but not started another
        this.sent_instructions_count = 0
        this.now_processing_instruction = null // a Dexter can only be doing at most 1 instruction at a time. This is it.
        if (this.sim_actual === true) { //do not call new_socket_callback if simulate is "both" because we don't want to call it twice
            Socket.new_socket_callback(this.robot_name)
        }
    }

    static create_or_just_init(robot_name, sim_actual = "required"){
        if (!DexterSim.robot_name_to_dextersim_instance_map){
            DexterSim.init_all()
        }
        var sim_inst = DexterSim.robot_name_to_dextersim_instance_map[robot_name]
        if(!sim_inst) { sim_inst = new DexterSim(robot_name) }
        sim_inst.init(sim_actual)
    }

    static stop_all_sims(){
        for(var sim_inst in Dextersim.sim_inst_next_inst_time_map){
            sim_inst.stop_sim()
        }
    }

    stop_sim(){
        this.status = "closed"
    }

    //typically adds instruction to sim_inst.instruction_queue
    static send(robot_name, instruction_array){ //instruction_array is in arcseconds
        //out("Sim.send passed instruction_array: " + instruction_array + " robot_name: " + robot_name)
        let sim_inst = DexterSim.robot_name_to_dextersim_instance_map[robot_name]
        sim_inst.sent_instructions_count += 1
        if (sim_inst.status == "closing"){
            shouldnt("In a_DexterSim.send with robot_name: " + robot_name +
                     " passed instruction_array: " + instruction_array +
                     " but it shouldn't be called at all because a_DexterSim.status == 'closing'.")
        }
        sim_inst.status = "after_first_send"
        let oplet  = instruction_array[Dexter.INSTRUCTION_TYPE]
        switch(oplet){
            //case "E":  //empty_instruction_queue_immediately
            //now handled by the default clause below, and add_instruction_to_queue
            case "F": //empty_instruction_queue, //waits to be "executed" when instruction is processed
                sim_inst.add_instruction_to_queue(instruction_array)
                break;
            case "g": //get naturally. This is like "F" in that it lets the buffer empty out.
                //so like F, don't ack_reply. This is automatically sent as the last instruction in a job.
                //it always returns a full robot_status in order.
                sim_inst.add_instruction_to_queue(instruction_array)
                break;
            case "G": //get immediate. The very first instruction sent to send should be  "G",
                                     //so let it be the first call to process_next_instruction & start out the setTimeout chain
                sim_inst.add_instruction_to_queue(instruction_array) //stick it on the front of the queue so it will be done next
                break;
            case "h": //doesn't go on instruction queue, just immediate ack
                sim_inst.ack_reply(instruction_array)
                break;
            default:
                sim_inst.add_instruction_to_queue(instruction_array)
                sim_inst.ack_reply(instruction_array)
                break;
        }
    }

    ack_reply(instruction_array){
        let ack_array = new Array(Dexter.robot_ack_labels.length)
        ack_array[Dexter.JOB_ID]            = instruction_array[Instruction.JOB_ID]
        ack_array[Dexter.INSTRUCTION_ID]    = instruction_array[Instruction.INSTRUCTION_ID]
        ack_array[Dexter.START_TIME]        = Date.now()
        ack_array[Dexter.STOP_TIME]         = Date.now()
        ack_array[Dexter.INSTRUCTION_TYPE]  = instruction_array[Instruction.INSTRUCTION_TYPE] //leave this as a 1 char string for now. helpful for debugging
        ack_array[Dexter.ERROR_CODE]        = 0
        if (this.sim_actual === true){
            let rob = this.robot
            setTimeout(function(){
                        //rob.robot_done_with_instruction(ack_array)
                        Socket.on_receive_sim(ack_array, rob.name)
                        }, 1)
        }
    }

    //this is the method that moves an instrucction from the "DDE side"
    //to the "hardware side"
    add_instruction_to_queue(instruction_array){
        const oplet = instruction_array[Dexter.INSTRUCTION_TYPE]
        if (oplet == "E") { //empty_instruction_queue_immediately
            out("In simulating Dexter at robot_name: " + this.robot_name +
                ", an E instruction (empty_instruction_queue_immediately),<br/> is " +
                "deleting " + this.instruction_queue.length + " instructions:<br/>" +
                this.instruction_queue.join("<br/>") +
                "<br/>from the queue. They will never be run.")
            this.instruction_queue = []
        }
        else { this.instruction_queue.push(instruction_array) }
    }

    //hardware side methods below
    static process_next_instructions(){
        const the_now = Date.now() //in milliseconds
        //for(var sim_inst in DexterSim.robot_name_to_dextersim_instance_map.values()){
        for(var robot_name in DexterSim.robot_name_to_dextersim_instance_map){
            const sim_inst = DexterSim.robot_name_to_dextersim_instance_map[robot_name]
            //hits when just ending an instruction
            if (sim_inst.now_processing_instruction &&
                (sim_inst.ending_time_of_cur_instruction <= the_now)) { //end the cur instruction and move to the next
                let rs_copy = sim_inst.robot_status_in_arcseconds.slice() //make a copy to return as some subseqent call to this meth will modify the one "model of dexter" that we're saving in the instance
                rs_copy[Dexter.STOP_TIME] = Date.now() //in milliseconds
                const oplet = sim_inst.now_processing_instruction[Dexter.INSTRUCTION_TYPE]
                if ((sim_inst.sim_actual === true) && ["F", "G", "g"].includes(oplet)) { //dont do when sim == "both"
                    //Socket.convert_robot_status_to_degrees(rs_copy)
                    //sim_inst.robot.robot_done_with_instruction(rs_copy)
                    Socket.on_receive_sim(rs_copy, sim_inst.robot.name)
                }
                sim_inst.completed_instructions.push(sim_inst.now_processing_instruction)
                sim_inst.now_processing_instruction = null     //Done with cur ins,
                sim_inst.ready_to_start_new_instruction = true
            }
            //hits when there's more on the queue to do
            if(sim_inst.ready_to_start_new_instruction &&
                (sim_inst.instruction_queue.length > 0) &&
                (sim_inst.status != "closed")) {
                sim_inst.ready_to_start_new_instruction = false
                sim_inst.process_next_instruction()
            }
            if((sim_inst.instruction_queue.length == 0) && //nothing in the queue,
                (sim_inst.status == "closing")) {          //and no more coming from DDE.
                sim_inst.ready_to_start_new_instruction = false
                DexterSim.close(sim_inst.robot_name)       //cleaner to set "closed" in one place.
            }
        }
    }



    process_next_instruction(){
        let dur = 10 // in ms
        this.now_processing_instruction = this.instruction_queue.shift() //pop off next inst from front of the list
        let instruction_array = this.now_processing_instruction
        var robot_status = this.robot_status_in_arcseconds
        var oplet  = instruction_array[Dexter.INSTRUCTION_TYPE]
        robot_status[Dexter.JOB_ID]            = instruction_array[Instruction.JOB_ID]
        robot_status[Dexter.INSTRUCTION_ID]    = instruction_array[Instruction.INSTRUCTION_ID]
        robot_status[Dexter.START_TIME]        = Date.now() //in ms
        robot_status[Dexter.INSTRUCTION_TYPE]  = instruction_array[Instruction.INSTRUCTION_TYPE] //leave this as a 1 char string for now. helpful for debugging
        robot_status[Dexter.ERROR_CODE]        = 0
        robot_status[Dexter.JOB_ID_OF_CURRENT_INSTRUCTION] = instruction_array[Instruction.JOB_ID]
        robot_status[Dexter.CURRENT_INSTRUCTION_ID] = instruction_array[Instruction.INSTRUCTION_ID]

        let ins_args = Instruction.args(instruction_array) //in arcseconds
        switch (oplet){
            case "a": //move_all_joints
                //this.robot.angles = ins_args //only set this in move_all_joints and friends
                dur = this.process_next_instruction_a(ins_args) //Vector.add(ins_args))
                break;
            //case "b": //move_to  xyz
                /*if (!isNaN(instruction_array[2])) robot_status[Dexter.ds_j5_x_index]     = instruction_array[2]
                if (!isNaN(instruction_array[3])) robot_status[Dexter.ds_j5_y_index]     = instruction_array[3]
                if (!isNaN(instruction_array[4])) robot_status[Dexter.ds_j5_z_index]     = instruction_array[4]
                if (!isNaN(instruction_array[5])) robot_status[Dexter.ds_j4_angle_index] = instruction_array[5]
                DexterSim.fill_in_robot_status_joint_angles(robot_status)
                */
             //   break;
           // case "B": //move_to_relative  xyz
                /*if (!isNaN(instruction_array[2])) robot_status[Dexter.ds_j5_x_index]     = robot_status[Dexter.ds_j5_x_index] + instruction_array[2]
                if (!isNaN(instruction_array[3])) robot_status[Dexter.ds_j5_y_index]     = robot_status[Dexter.ds_j5_y_index] + instruction_array[3]
                if (!isNaN(instruction_array[4])) robot_status[Dexter.ds_j5_z_index]     = robot_status[Dexter.ds_j5_z_index] + instruction_array[4]
                if (!isNaN(instruction_array[5])) robot_status[Dexter.ds_j4_angle_index] = instruction_array[5] //not relative
                DexterSim.fill_in_robot_status_joint_angles(robot_status)*/
             //   break;
            case "e": //cause an error. Used for testing only
                robot_status[Dexter.ERROR_CODE] = instruction_array[2]
                break;
            case "F":
                dur = 0
                break;
            case "g": //get_robot_status
                dur = 0;
                break;
            case "G": //get_robot_status_immediately
                dur = 0;
                break;
            //handled by send. h never gets to this fn
            case "h": //heartbeat get robot status
                //dur = 0;
                shouldnt("In dextersim.process_next_instruction, got an 'h' oplet but this fn shouldn't get 'h' instructions.")
                break;
            case "P": //pid_move_all_joints
                this.robot.pid_angles = ins_args //but not used aug 27, 2018
                dur = this.process_next_instruction_a(Vector.add(ins_args))
            break;
            case "R": //move_all_joints_relative //no longer used because Dexter.move_all_joints_relative  converts to "a" oplet
                let angle = ins_args[0]
                if (!isNaN(angle)){ robot_status[Dexter.J1_ANGLE] += angle}
                angle = ins_args[1]
                if (!isNaN(angle)){ robot_status[Dexter.J2_ANGLE] += angle}
                angle = ins_args[2]
                if (!isNaN(angle)){ robot_status[Dexter.J3_ANGLE] += angle}
                angle = ins_args[3]
                if (!isNaN(angle)){ robot_status[Dexter.J4_ANGLE] += angle}
                angle = ins_args[4]
                if (!isNaN(angle)){ robot_status[Dexter.J5_ANGLE] += angle}
                //DexterSim.fill_in_robot_status_xyzs(robot_status)
                break;
            case "r":
                this.process_next_instruction_r(instruction_array)
                break;
            case "S": //set_parameter
                this.parameters[ins_args[0]] = ins_args[1]
                dur = 0
                break
            case "T": //move_to_straight, the oplet version
                dur = this.process_next_instruction_T(ins_args)
                break
            case "w": //write
                dur = 0
                const write_location = ins_args[0]
                if (write_location < this.write_array.length) {
                    this.write_array[write_location] = ins_args[1]
                }
                else { shouldnt('DexterSim.write_array is too short to accommodate "w" instruction<br/> with write_location of: ' +
                                 write_location + " and value of: " + ins_args[1]) }
                break
            case "z": //sleep
                dur = Math.round(ins_args[0] / 1000) //ins_args z sleep time is in microseconds,
                                               //converted from secs to to usecs in in socket.js
                break;
            default:
                if (Dexter.instruction_type_to_function_name_map[oplet]){
                    warning("Dextersim.send doesn't know what to do with the legal oplet: " + oplet)
                }
                else {
                    warning("DexterSim.send received an instruction array with an illegal oplet: " + instruction_array)
                }
        }
        //if (oplet != "h"){  //never put -1 in instruction_id of robot status except before first instruction is run.
        //For heartbeats, we want to leave in robot_status whatever the last "real" instruction was in there.
        //    ds_copy[0] = instruction_array[0] //instruction id
                //}
        if (!$("#real_time_sim_checkbox_id").val()){
            dur = 0
        }
        this.ending_time_of_cur_instruction = robot_status[Dexter.START_TIME] + dur
        const job_id       = robot_status[Dexter.JOB_ID]
        const job_instance = Job.job_id_to_job_instance(job_id)
        if (job_instance){
            SimUtils.render_once(robot_status, "Job: " + job_instance.name) //renders after dur, ie when the dexter move is completed.
        }
        else {
            this.instruction_queue = []
            this.now_processing_instruction = null
            DexterSim.close(this.name)
            dde_error("in Dexter Simulation, could not find a job with job_id: " + job_id)
        }
    }

    // also called by process_next_instruction_T(
    process_next_instruction_a(ins_args){ //ins_args in arcseconds
        var robot_status = this.robot_status_in_arcseconds
        let idxs = [Dexter.J1_MEASURED_ANGLE, Dexter.J2_MEASURED_ANGLE, Dexter.J3_MEASURED_ANGLE,
            Dexter.J4_MEASURED_ANGLE, Dexter.J5_MEASURED_ANGLE, Dexter.J6_MEASURED_ANGLE, Dexter.J7_MEASURED_ANGLE]

        let orig_angles =  [] //in arcseconds
        for(let i of idxs) { orig_angles.push(robot_status[i]) }
        //set the angles in this robot's robot_status
        for(let i = 0; i < ins_args.length; i++){
            let angle = ins_args[i]
            if (!isNaN(angle)){
                robot_status[idxs[i]] = angle
            }
        }
        //predict needs its angles in degrees but ins_args are in arcseconds
        const orig_angles_in_deg = orig_angles.map(function(ang) { return ang / 3600 })
        const ins_args_in_deg    = ins_args.map(function(ang)    { return ang / 3600 })
        //predict_move_dur takes degrees in and returns seconds
        let dur_in_seconds = Math.abs(Kin.predict_move_dur(orig_angles_in_deg, ins_args_in_deg, this.robot))
        let dur_in_milliseconds = dur_in_seconds * 1000
        return dur_in_milliseconds
    }

    process_next_instruction_T(ins_args){ //ins_args xyz in microns
        let xyz_in_microns = [ins_args[0], ins_args[1], ins_args[2]]
        let J5_direction = [ins_args[3], ins_args[4], ins_args[5]]
        let config       = [ins_args[6], ins_args[7], ins_args[8]]
        let j6_angle     = ins_args[11]
        let j7_angle     = ins_args[12]
        let pose         = undefined //its not in the ins_args, and defaults just fine

        let xyz_in_meters = [xyz_in_microns[0] / 1000000,
                             xyz_in_microns[1] / 1000000,
                             xyz_in_microns[2] / 1000000]
        let angles_in_degrees = Kin.xyz_to_J_angles(xyz_in_meters, J5_direction, config, pose)
        let angles_in_arcseconds = angles_in_degrees.map(function(deg) { return deg * 3600})
        angles_in_arcseconds.push(j6_angle)
        angles_in_arcseconds.push(j7_angle)
        return this.process_next_instruction_a(angles_in_arcseconds)
    }

    process_next_instruction_r(instruction_array) {
        //let job_id = instruction_array[Instruction.JOB_ID]
        //let ins_id = instruction_array[Instruction.INSTRUCTION_ID]
        let hunk_index = instruction_array[Instruction.INSTRUCTION_ARG0]
        let source     = instruction_array[Instruction.INSTRUCTION_ARG1]
        let whole_content = file_content(source) //errors if path in "source" doesn't exist
        let start_index = hunk_index * Instruction.Control.read_from_robot.payload_max_chars
        let end_index = start_index + Instruction.Control.read_from_robot.payload_max_chars
        let payload_string = whole_content.substring(start_index, end_index) //ok if end_index is > whole_cotnent.length, it just gets how much it can, no error
        //out("some content from " + source + " hunk: " + hunk_index + " payload: " + payload_string)
        Socket.r_payload_grab_aux(payload_string, instruction_array)
        //Instruction.Control.read_from_robot.got_content_hunk(job_id, ins_id, payload_string)
    }

    static close(robot_name){
        //when this is called, no more instructions will be coming from the job, but there might be
        //be stragglers left in the instruction_queue
        if (DexterSim.robot_name_to_dextersim_instance_map) { //because close might be called before we init the map
            let sim_inst = DexterSim.robot_name_to_dextersim_instance_map[robot_name]
            if(sim_inst){
               if ((sim_inst.instruction_queue.length == 0) &&
                   (sim_inst.now_processing_instruction == null)){
                    sim_inst.stop_sim() //also set near bottom of process_next_instruction
                }
                else { //note: now that I automatically put a "g" instruction as the automatic last instruction
                //of a job's do_list, we shouldn't be getting this "closing" state because
                //the "g" naturally empties the instruction_queue.
                sim_inst.status = "closing"
                //setTimeout(function(){DexterSim.close(socket_id)}, 1000) //shouldn't be necessary.
                //as process_next_instruction will handle final close in this case.
                }
            }
        }
    }

    static empty_instruction_queue_now(robot_name){
        let sim_inst = DexterSim.robot_name_to_dextersim_instance_map[robot_name]
        sim_inst.instruction_queue = []
    }
    
}

DexterSim.robot_name_to_dextersim_instance_map = null
DexterSim.set_interval_id      = null